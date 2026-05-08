/**
 * Chat SDK StateAdapter backed by Postgres (central DB).
 * Persists subscriptions, locks, KV, and lists across restarts.
 *
 * Renamed from SqliteStateAdapter for clarity; file kept as state-sqlite.ts
 * for minimal import-path churn (callers import by path, not class name).
 */
import crypto from 'crypto';

import type { StateAdapter, QueueEntry } from 'chat';

import { get, all, run, getPool } from './db/connection.js';

interface Lock {
  threadId: string;
  token: string;
  expiresAt: number;
}

export class SqliteStateAdapter implements StateAdapter {
  async connect(): Promise<void> {
    await this.cleanup();
  }

  async disconnect(): Promise<void> {}

  // --- Key-value ---

  async get<T = unknown>(key: string): Promise<T | null> {
    await this.cleanup();
    const row = await get<{ value: string; expires_at: number | null }>(
      'SELECT value, expires_at FROM chat_sdk_kv WHERE key = $1',
      [key],
    );
    if (!row) return null;
    if (row.expires_at && row.expires_at < Date.now()) {
      await run('DELETE FROM chat_sdk_kv WHERE key = $1', [key]);
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    await run(
      `INSERT INTO chat_sdk_kv (key, value, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      [key, JSON.stringify(value), expiresAt],
    );
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    // Delete expired entry first
    await run('DELETE FROM chat_sdk_kv WHERE key = $1 AND expires_at IS NOT NULL AND expires_at < $2', [
      key,
      Date.now(),
    ]);
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    const rows = await run(
      `INSERT INTO chat_sdk_kv (key, value, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value), expiresAt],
    );
    return rows > 0;
  }

  async delete(key: string): Promise<void> {
    await run('DELETE FROM chat_sdk_kv WHERE key = $1', [key]);
  }

  // --- Subscriptions ---

  async subscribe(threadId: string): Promise<void> {
    await run(
      `INSERT INTO chat_sdk_subscriptions (thread_id)
       VALUES ($1)
       ON CONFLICT (thread_id) DO NOTHING`,
      [threadId],
    );
  }

  async unsubscribe(threadId: string): Promise<void> {
    await run('DELETE FROM chat_sdk_subscriptions WHERE thread_id = $1', [threadId]);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    const row = await get('SELECT 1 FROM chat_sdk_subscriptions WHERE thread_id = $1 LIMIT 1', [threadId]);
    return !!row;
  }

  // --- Locks ---

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const now = Date.now();
    const token = crypto.randomUUID();
    const expiresAt = now + ttlMs;
    await run('DELETE FROM chat_sdk_locks WHERE thread_id = $1 AND expires_at < $2', [threadId, now]);
    const rows = await run(
      `INSERT INTO chat_sdk_locks (thread_id, token, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (thread_id) DO NOTHING`,
      [threadId, token, expiresAt],
    );
    if (rows === 0) return null;
    return { threadId, token, expiresAt };
  }

  async releaseLock(lock: Lock): Promise<void> {
    await run('DELETE FROM chat_sdk_locks WHERE thread_id = $1 AND token = $2', [lock.threadId, lock.token]);
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const newExpiry = Date.now() + ttlMs;
    const rows = await run('UPDATE chat_sdk_locks SET expires_at = $1 WHERE thread_id = $2 AND token = $3', [
      newExpiry,
      lock.threadId,
      lock.token,
    ]);
    if (rows > 0) {
      lock.expiresAt = newExpiry;
      return true;
    }
    return false;
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await run('DELETE FROM chat_sdk_locks WHERE thread_id = $1', [threadId]);
  }

  // --- Lists ---

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
    const expiresAt = options?.ttlMs ? Date.now() + options.ttlMs : null;
    const maxRow = await get<{ maxIdx: number | null }>(
      'SELECT MAX(idx) as "maxIdx" FROM chat_sdk_lists WHERE key = $1',
      [key],
    );
    const nextIdx = (maxRow?.maxIdx ?? -1) + 1;
    await run('INSERT INTO chat_sdk_lists (key, idx, value, expires_at) VALUES ($1, $2, $3, $4)', [
      key,
      nextIdx,
      JSON.stringify(value),
      expiresAt,
    ]);
    if (options?.maxLength) {
      const cutoff = nextIdx - options.maxLength;
      if (cutoff >= 0) {
        await run('DELETE FROM chat_sdk_lists WHERE key = $1 AND idx <= $2', [key, cutoff]);
      }
    }
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const now = Date.now();
    const rows = await all<{ value: string }>(
      'SELECT value FROM chat_sdk_lists WHERE key = $1 AND (expires_at IS NULL OR expires_at > $2) ORDER BY idx ASC',
      [key, now],
    );
    return rows.map((r) => JSON.parse(r.value) as T);
  }

  // --- Queue ---

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    const key = `queue:${threadId}`;
    await this.appendToList(key, entry, { maxLength: maxSize });
    return await this.queueDepth(threadId);
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const key = `queue:${threadId}`;
    // Use a transaction to atomically select-then-delete the first row
    return getPool()
      .connect()
      .then(async (client) => {
        try {
          await client.query('BEGIN');
          const res = await client.query<{ idx: number; value: string }>(
            'SELECT idx, value FROM chat_sdk_lists WHERE key = $1 ORDER BY idx ASC LIMIT 1',
            [key],
          );
          if (res.rows.length === 0) {
            await client.query('COMMIT');
            return null;
          }
          const row = res.rows[0];
          await client.query('DELETE FROM chat_sdk_lists WHERE key = $1 AND idx = $2', [key, row.idx]);
          await client.query('COMMIT');
          return JSON.parse(row.value) as QueueEntry;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      });
  }

  async queueDepth(threadId: string): Promise<number> {
    const key = `queue:${threadId}`;
    const row = await get<{ count: string }>('SELECT COUNT(*) as count FROM chat_sdk_lists WHERE key = $1', [key]);
    return Number(row?.count ?? 0);
  }

  // --- Cleanup ---

  private async cleanup(): Promise<void> {
    const now = Date.now();
    await run('DELETE FROM chat_sdk_kv WHERE expires_at IS NOT NULL AND expires_at < $1', [now]);
    await run('DELETE FROM chat_sdk_locks WHERE expires_at < $1', [now]);
    await run('DELETE FROM chat_sdk_lists WHERE expires_at IS NOT NULL AND expires_at < $1', [now]);
  }
}
