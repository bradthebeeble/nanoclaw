/**
 * Central-DB connection layer using pg.Pool against PgBouncer 1.22+ in
 * transaction mode.
 *
 * INVARIANTS (do not violate — see CLAUDE.md + FOUND-03):
 *  - This file MUST NOT import better-sqlite3 (central DB is Postgres).
 *  - session-db.ts is the ONLY file allowed to import better-sqlite3.
 *  - Pool size: max 2–5 (real pooling at PgBouncer, not here).
 *  - NEVER use named prepared statements (pool.query with a `name` property) —
 *    they break PgBouncer transaction mode (Pitfall 2 from 01-RESEARCH.md).
 *    Use pool.query(text, values) always.
 *
 * PG credentials come from env vars (PGHOST, PGPORT, PGUSER, PGPASSWORD,
 * PGDATABASE) — injected by Helm values referencing K8s Secret per plan 08.
 */
import { Pool, type PoolClient } from 'pg';

import { log } from '../log.js';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) throw new Error('Database not initialized. Call initDb() first.');
  return _pool;
}

/**
 * Initialise the central-DB pool. Call once at startup in src/index.ts.
 *
 * Reads connection details from standard PG env vars (PGHOST, PGPORT,
 * PGUSER, PGPASSWORD, PGDATABASE) so no explicit config is needed here.
 * Falls back to a test DSN if DB_URL_TEST is set (test environment only).
 */
export function initDb(): Pool {
  if (_pool) return _pool;

  _pool = new Pool({
    // Connection details come from PG standard env vars.
    // If DB_URL_TEST is set (test environment), parse from that DSN.
    ...(process.env['DB_URL_TEST']
      ? (() => {
          const u = new URL(process.env['DB_URL_TEST']!);
          return {
            host: u.hostname,
            port: Number(u.port) || 5432,
            user: u.username,
            password: u.password,
            database: u.pathname.slice(1),
          };
        })()
      : {}),
    max: Number(process.env['DB_POOL_MAX'] ?? 4), // FOUND-06: cap 2–5
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  _pool.on('error', (err) => {
    // Log only code/message — never log connection string (T-06-02).
    log.error('pg pool error', { code: (err as NodeJS.ErrnoException).code, message: err.message });
  });

  log.info('Central DB pool initialised', { max: Number(process.env['DB_POOL_MAX'] ?? 4) });
  return _pool;
}

/**
 * For tests only — creates a pool pointing at a testcontainers Postgres.
 * Pass the StartedPostgreSqlContainer connection details.
 */
export function initTestDb(opts: { host: string; port: number; database: string; user: string; password: string }): Pool {
  if (_pool) {
    void _pool.end();
  }
  _pool = new Pool({
    ...opts,
    max: 3,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  return _pool;
}

/** Close the pool. Used in tests and graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// ── Query helpers — wrap pool.query to enforce positional $N params ──
// These replace the synchronous better-sqlite3 prepared-statement pattern.
// All helpers enforce the no-named-prepared-statement rule automatically.

/**
 * Execute a query returning zero or one row. Returns undefined when no row
 * matches (mirrors better-sqlite3's `stmt.get()`).
 */
export async function get<T extends object>(text: string, values?: unknown[]): Promise<T | undefined> {
  const result = await getPool().query<T>(text, values);
  return result.rows[0];
}

/**
 * Execute a query returning all matching rows (mirrors better-sqlite3's
 * `stmt.all()`).
 */
export async function all<T extends object>(text: string, values?: unknown[]): Promise<T[]> {
  const result = await getPool().query<T>(text, values);
  return result.rows;
}

/**
 * Execute a DML statement (INSERT / UPDATE / DELETE). Returns rowCount.
 * Mirrors better-sqlite3's `stmt.run()`.
 */
export async function run(text: string, values?: unknown[]): Promise<number> {
  const result = await getPool().query(text, values);
  return result.rowCount ?? 0;
}

/**
 * Execute a callback inside a transaction. The callback receives a PoolClient.
 * On exception: ROLLBACK + rethrow. On success: COMMIT + return value.
 */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Check whether a table exists. Postgres equivalent of the SQLite
 * `sqlite_master` check used in the old connection.ts. Used by callers
 * (e.g. messaging-groups.ts) that guard optional module tables.
 */
export async function hasTable(name: string): Promise<boolean> {
  const result = await getPool().query<{ found: string | null }>(
    `SELECT to_regclass($1) AS found`,
    [`public.${name}`],
  );
  return result.rows[0]?.found !== null;
}
