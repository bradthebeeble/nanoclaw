/**
 * Migration registry for the NanoClaw EE Postgres central DB.
 *
 * DESIGN NOTE — why only one migration in the registry:
 *
 *   The upstream NanoClaw OSS codebase had 11 SQLite migrations (001–013
 *   with some gaps). Rather than re-running those SQLite-specific migrations
 *   against Postgres (they use SQLite-only SQL and backfill logic), we apply
 *   the cumulative final schema in one shot via `000-postgres-init.ts`.
 *   That migration also BACKFILLS schema_version with all 11 upstream migration
 *   names, so if any of them were ever added to this registry by mistake, the
 *   runner would see them as already-applied and skip them.
 *
 *   Future NanoClaw EE-specific migrations should be added here following the
 *   pattern below (version number >= 100 to avoid collisions with upstream).
 */
import type { Pool, PoolClient } from 'pg';

import { log } from '../../log.js';
import { migrationPostgresInit } from './000-postgres-init.js';

export interface Migration {
  version: number;
  name: string;
  up: (client: PoolClient) => Promise<void>;
}

/**
 * Registry of EE-specific migrations. The upstream OSS migrations are
 * represented by the single `migrationPostgresInit` entry which applies the
 * full schema in one shot and backfills schema_version for all 11 upstream
 * migration names.
 *
 * To add a new EE migration:
 *   1. Create `NNN-migration-name.ts` in this directory with:
 *        export async function up(client: PoolClient): Promise<void> { ... }
 *        export const migrationNNN = { version: NNN, name: 'migration-name', up };
 *   2. Import it here and add to the `migrations` array (in version order).
 *   3. Use $N positional params only — NO named prepared statements (PgBouncer invariant).
 */
const migrations: Migration[] = [
  migrationPostgresInit,
  // Future EE migrations here (version >= 100)
];

/**
 * Run all pending migrations against the given pool.
 *
 * Algorithm:
 *   1. Create schema_version if not exists (idempotent bootstrap).
 *   2. Load applied migration names.
 *   3. For each pending migration: BEGIN + up(client) + INSERT name + COMMIT.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  // Bootstrap schema_version outside a transaction so it's visible immediately.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_version');
  const applied = new Set<string>(rows.map((r) => r.name));

  const pending = migrations.filter((m) => !applied.has(m.name));
  if (pending.length === 0) {
    log.info('Migrations: all up to date');
    return;
  }

  log.info('Running migrations', { count: pending.length });

  for (const m of pending) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');

      await m.up(client);

      // Assign the next sequential version number.
      const versionResult = await client.query<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version`,
      );
      const next = versionResult.rows[0].v;

      await client.query(
        `INSERT INTO schema_version (version, name, applied) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO NOTHING`,
        [next, m.name, new Date().toISOString()],
      );

      await client.query('COMMIT');
      log.info('Migration applied', { name: m.name });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
