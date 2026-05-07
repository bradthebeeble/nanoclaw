/**
 * Migration idempotency and semantic correctness tests.
 *
 * RED phase: these fail until 000-postgres-init.ts + pg.Pool connection.ts exist.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// These imports will fail (RED) until the pg migration system exists.
import { runMigrations } from './index.js';
import { getPool, initDb, closeDb } from '../connection.js';

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('nanoclaw_mig_test')
    .withUsername('nanoclaw')
    .withPassword('nanoclaw_test_pw')
    .start();
}, 120_000);

afterAll(async () => {
  await container.stop();
});

// ── M1: idempotent re-application ──

describe('M1: idempotent re-application', () => {
  it('running runMigrations twice does not throw and schema_version row count is identical', async () => {
    const pool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
      max: 3,
    });

    try {
      // First run
      await runMigrations(pool);

      const before = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM schema_version`,
      );
      const countBefore = Number(before.rows[0].count);

      // Second run — MUST NOT throw
      await expect(runMigrations(pool)).resolves.not.toThrow();

      const after = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM schema_version`,
      );
      const countAfter = Number(after.rows[0].count);

      expect(countAfter).toBe(countBefore);
      expect(countBefore).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});

// ── M2: INSERT OR IGNORE → ON CONFLICT DO NOTHING translation ──

describe('M2: ON CONFLICT DO NOTHING translation (pending_questions idempotency)', () => {
  let pool: Pool;

  beforeAll(async () => {
    // Fresh DB for this test group
    pool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
      max: 3,
    });
    await runMigrations(pool);

    // Seed prerequisite rows: agent_group + session (pending_questions.session_id FK)
    await pool.query(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      ['ag-m2-test', 'M2 Agent', 'agent-m2', null, new Date().toISOString()],
    );
    await pool.query(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      ['sess-m2-test', 'ag-m2-test', null, null, null, 'active', 'stopped', null, new Date().toISOString()],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('inserting the same pending_questions row twice does not throw and does not duplicate', async () => {
    const pq = {
      question_id: 'pq-idempotent-test',
      session_id: 'sess-m2-test',
      message_out_id: 'msg-out-1',
      platform_id: null,
      channel_type: null,
      thread_id: null,
      title: 'Idempotency test',
      options_json: '[]',
      created_at: new Date().toISOString(),
    };

    // First insert
    await pool.query(
      `INSERT INTO pending_questions
         (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, options_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (question_id) DO NOTHING`,
      [pq.question_id, pq.session_id, pq.message_out_id, pq.platform_id, pq.channel_type, pq.thread_id, pq.title, pq.options_json, pq.created_at],
    );

    // Second insert with same key — must NOT throw
    await expect(pool.query(
      `INSERT INTO pending_questions
         (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, options_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (question_id) DO NOTHING`,
      [pq.question_id, pq.session_id, pq.message_out_id, pq.platform_id, pq.channel_type, pq.thread_id, pq.title, pq.options_json, pq.created_at],
    )).resolves.not.toThrow();

    // Exactly one row
    const count = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pending_questions WHERE question_id = $1`,
      [pq.question_id],
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });
});

// ── M3: pg.Pool round-trip on every table ──

describe('M3: pg.Pool round-trip on core tables', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
      max: 3,
    });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('agent_groups: insert + read round-trip', async () => {
    const id = 'rt-ag-' + Date.now();
    const created_at = new Date().toISOString();
    await pool.query(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, 'RT Agent', 'rt-agent-' + Date.now(), null, created_at],
    );
    const result = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM agent_groups WHERE id = $1`,
      [id],
    );
    expect(result.rows[0].id).toBe(id);
    expect(result.rows[0].name).toBe('RT Agent');
  });

  it('messaging_groups: insert + read round-trip', async () => {
    const id = 'rt-mg-' + Date.now();
    const platformId = 'rt-platform-' + Date.now();
    const created_at = new Date().toISOString();
    await pool.query(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, 'discord', platformId, 'RT Channel', 1, 'strict', created_at],
    );
    const result = await pool.query<{ channel_type: string }>(
      `SELECT channel_type FROM messaging_groups WHERE id = $1`,
      [id],
    );
    expect(result.rows[0].channel_type).toBe('discord');
  });

  it('users: insert + read round-trip', async () => {
    const id = 'rt-user-' + Date.now();
    const created_at = new Date().toISOString();
    await pool.query(
      `INSERT INTO users (id, kind, display_name, created_at)
       VALUES ($1, $2, $3, $4)`,
      [id, 'discord', 'RT User', created_at],
    );
    const result = await pool.query<{ kind: string }>(
      `SELECT kind FROM users WHERE id = $1`,
      [id],
    );
    expect(result.rows[0].kind).toBe('discord');
  });

  it('sessions: insert + read round-trip', async () => {
    // Need agent_group first
    const agId = 'rt-ag-sess-' + Date.now();
    await pool.query(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [agId, 'RT Session Agent', 'rt-sess-agent-' + Date.now(), null, new Date().toISOString()],
    );

    const id = 'rt-sess-' + Date.now();
    await pool.query(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, agId, null, null, null, 'active', 'stopped', null, new Date().toISOString()],
    );
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM sessions WHERE id = $1`,
      [id],
    );
    expect(result.rows[0].status).toBe('active');
  });

  it('unregistered_senders: upsert round-trip', async () => {
    const channelType = 'rt-ch-' + Date.now();
    const platformId = 'rt-pid-' + Date.now();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO unregistered_senders
         (channel_type, platform_id, user_id, sender_name, reason, messaging_group_id, agent_group_id, message_count, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (channel_type, platform_id) DO UPDATE SET message_count = unregistered_senders.message_count + 1, last_seen = $10`,
      [channelType, platformId, null, 'RT Sender', 'no_group', null, null, 1, now, now],
    );
    const result = await pool.query<{ message_count: number }>(
      `SELECT message_count FROM unregistered_senders WHERE channel_type = $1 AND platform_id = $2`,
      [channelType, platformId],
    );
    expect(result.rows[0].message_count).toBe(1);
  });
});
