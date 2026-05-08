/**
 * 000-postgres-init: One-shot migration that applies the full NanoClaw v2.db
 * schema to Postgres in a single transaction.
 *
 * Design notes (read before editing):
 *
 *  1. This migration does NOT re-run the upstream SQLite migrations (001–013).
 *     Instead it applies the FINAL cumulative schema directly — i.e. the schema
 *     that results from running all 11 upstream migrations in sequence. This
 *     avoids reproducing SQLite-specific migration logic (ALTER TABLE, DROP
 *     COLUMN, JSON backfills) in Postgres.
 *
 *  2. It BACKFILLS schema_version with all 11 upstream migration names using
 *     INSERT … ON CONFLICT (name) DO NOTHING so that:
 *     - Idempotent re-runs don't error or duplicate rows (M1 test).
 *     - The migration runner doesn't try to re-apply upstream migrations if
 *       they were ever added to the registry by mistake (failsafe).
 *
 *  3. SQL dialect notes (per 01-RESEARCH.md Pitfall 4/5):
 *     - TEXT columns for every string field (PG TEXT = unlimited length; fine).
 *     - INTEGER for is_group/priority/message_count (PG INTEGER = 32-bit; fine
 *       for these small values).
 *     - No AUTOINCREMENT — use SERIAL or leave PKs as TEXT (most are TEXT UUIDs
 *       or string identifiers).
 *     - No SQLite datetime() — values are stored as TEXT ISO-8601 strings by
 *       the application; Postgres handles them transparently.
 *     - chat_sdk_subscriptions.subscribed_at used `DEFAULT (datetime('now'))`
 *       in the SQLite migration — replaced with `DEFAULT NOW()` here.
 *
 *  4. Upstream migrations included in this file:
 *     001 initial-v2-schema, 002 chat-sdk-state,
 *     003 pending-approvals (moduleApprovalsPendingApprovals),
 *     004 agent-destinations (moduleAgentToAgentDestinations),
 *     007 pending-approvals-title-options (moduleApprovalsTitleOptions),
 *     008 dropped-messages, 009 drop-pending-credentials,
 *     010 engage-modes, 011 pending-sender-approvals,
 *     012 channel-registration, 013 approval-render-metadata
 *     (total: 11 migrations → 11 schema_version rows backfilled)
 */
import type { PoolClient } from 'pg';

// Names of all 11 upstream SQLite migrations that this Postgres-init
// migration subsumes. These are backfilled in schema_version so the
// migration runner skips them if they are ever registered.
export const UPSTREAM_MIGRATION_NAMES = [
  'initial-v2-schema', // 001
  'chat-sdk-state', // 002
  'pending-approvals', // 003 (moduleApprovalsPendingApprovals)
  'agent-destinations', // 004 (moduleAgentToAgentDestinations)
  'pending-approvals-title-options', // 007 (moduleApprovalsTitleOptions)
  'dropped-messages', // 008
  'drop-pending-credentials', // 009
  'engage-modes', // 010
  'pending-sender-approvals', // 011
  'channel-registration', // 012
  'approval-render-metadata', // 013
] as const;

export async function up(client: PoolClient): Promise<void> {
  // ── schema_version table (migration registry) ──
  // Must be created first so all subsequent inserts work.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);

  // ── From 001-initial: core entity tables ──

  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_groups (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      folder           TEXT NOT NULL UNIQUE,
      agent_provider   TEXT,
      created_at       TEXT NOT NULL
    );
  `);

  // messaging_groups includes denied_at from migration 012.
  await client.query(`
    CREATE TABLE IF NOT EXISTS messaging_groups (
      id                    TEXT PRIMARY KEY,
      channel_type          TEXT NOT NULL,
      platform_id           TEXT NOT NULL,
      name                  TEXT,
      is_group              INTEGER DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
      created_at            TEXT NOT NULL,
      denied_at             TEXT,
      UNIQUE(channel_type, platform_id)
    );
  `);

  // messaging_group_agents includes the post-010 column set:
  // engage_mode / engage_pattern / sender_scope / ignored_message_policy
  // (trigger_rules + response_scope were dropped by migration 010).
  await client.query(`
    CREATE TABLE IF NOT EXISTS messaging_group_agents (
      id                     TEXT PRIMARY KEY,
      messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
      agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
      engage_mode            TEXT,
      engage_pattern         TEXT,
      sender_scope           TEXT,
      ignored_message_policy TEXT,
      session_mode           TEXT DEFAULT 'shared',
      priority               INTEGER DEFAULT 0,
      created_at             TEXT NOT NULL,
      UNIQUE(messaging_group_id, agent_group_id)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      display_name TEXT,
      created_at   TEXT NOT NULL
    );
  `);

  // NOTE: user_roles uses two partial unique indexes instead of a compound
  // PRIMARY KEY because PostgreSQL does not allow NULL in primary key columns,
  // and agent_group_id IS NULL for global roles (owner + global admin).
  // SQLite allowed NULLs in compound PKs; Postgres requires partial indexes.
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id        TEXT NOT NULL REFERENCES users(id),
      role           TEXT NOT NULL,
      agent_group_id TEXT REFERENCES agent_groups(id),
      granted_by     TEXT REFERENCES users(id),
      granted_at     TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_global
      ON user_roles(user_id, role)
      WHERE agent_group_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_scoped
      ON user_roles(user_id, role, agent_group_id)
      WHERE agent_group_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_user_roles_scope ON user_roles(agent_group_id, role);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_group_members (
      user_id        TEXT NOT NULL REFERENCES users(id),
      agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
      added_by       TEXT REFERENCES users(id),
      added_at       TEXT NOT NULL,
      PRIMARY KEY (user_id, agent_group_id)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS user_dms (
      user_id            TEXT NOT NULL REFERENCES users(id),
      channel_type       TEXT NOT NULL,
      messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
      resolved_at        TEXT NOT NULL,
      PRIMARY KEY (user_id, channel_type)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                 TEXT PRIMARY KEY,
      agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
      messaging_group_id TEXT REFERENCES messaging_groups(id),
      thread_id          TEXT,
      agent_provider     TEXT,
      status             TEXT DEFAULT 'active',
      container_status   TEXT DEFAULT 'stopped',
      last_active        TEXT,
      created_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_group ON sessions(agent_group_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON sessions(messaging_group_id, thread_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS pending_questions (
      question_id    TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL REFERENCES sessions(id),
      message_out_id TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      title          TEXT NOT NULL,
      options_json   TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
  `);

  // ── From 002-chat-sdk-state ──
  // Note: subscribed_at uses DEFAULT NOW() instead of DEFAULT (datetime('now')).

  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_sdk_kv (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS chat_sdk_subscriptions (
      thread_id     TEXT PRIMARY KEY,
      subscribed_at TEXT NOT NULL DEFAULT (TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    );

    CREATE TABLE IF NOT EXISTS chat_sdk_locks (
      thread_id  TEXT PRIMARY KEY,
      token      TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sdk_lists (
      key        TEXT NOT NULL,
      idx        INTEGER NOT NULL,
      value      TEXT NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (key, idx)
    );
  `);

  // ── From 003-pending-approvals (moduleApprovalsPendingApprovals) ──
  // Includes title + options_json columns (backport from migration 007).

  await client.query(`
    CREATE TABLE IF NOT EXISTS pending_approvals (
      approval_id         TEXT PRIMARY KEY,
      session_id          TEXT REFERENCES sessions(id),
      request_id          TEXT NOT NULL,
      action              TEXT NOT NULL,
      payload             TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      agent_group_id      TEXT REFERENCES agent_groups(id),
      channel_type        TEXT,
      platform_id         TEXT,
      platform_message_id TEXT,
      expires_at          TEXT,
      status              TEXT NOT NULL DEFAULT 'pending',
      title               TEXT NOT NULL DEFAULT '',
      options_json        TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_action_status
      ON pending_approvals(action, status);
  `);

  // ── From 004-agent-destinations (moduleAgentToAgentDestinations) ──

  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_destinations (
      agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id),
      local_name      TEXT NOT NULL,
      target_type     TEXT NOT NULL,
      target_id       TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      PRIMARY KEY (agent_group_id, local_name)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_dest_target ON agent_destinations(target_type, target_id);
  `);

  // ── Migration 009: drop-pending-credentials ──
  // Table pending_credentials was created on old installs and then dropped.
  // On a fresh Postgres init there is nothing to drop, but we DROP IF EXISTS
  // for idempotency just in case.

  await client.query(`DROP TABLE IF EXISTS pending_credentials;`);

  // ── From 008-dropped-messages ──

  await client.query(`
    CREATE TABLE IF NOT EXISTS unregistered_senders (
      channel_type       TEXT NOT NULL,
      platform_id        TEXT NOT NULL,
      user_id            TEXT,
      sender_name        TEXT,
      reason             TEXT NOT NULL,
      messaging_group_id TEXT,
      agent_group_id     TEXT,
      message_count      INTEGER NOT NULL DEFAULT 1,
      first_seen         TEXT NOT NULL,
      last_seen          TEXT NOT NULL,
      PRIMARY KEY (channel_type, platform_id)
    );
    CREATE INDEX IF NOT EXISTS idx_unregistered_senders_last_seen
      ON unregistered_senders(last_seen);
  `);

  // ── From 011-pending-sender-approvals ──
  // Includes title + options_json (added by migration 013).

  await client.query(`
    CREATE TABLE IF NOT EXISTS pending_sender_approvals (
      id                   TEXT PRIMARY KEY,
      messaging_group_id   TEXT NOT NULL REFERENCES messaging_groups(id),
      agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
      sender_identity      TEXT NOT NULL,
      sender_name          TEXT,
      original_message     TEXT NOT NULL,
      approver_user_id     TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      title                TEXT NOT NULL DEFAULT '',
      options_json         TEXT NOT NULL DEFAULT '[]',
      UNIQUE(messaging_group_id, sender_identity)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_sender_approvals_mg
      ON pending_sender_approvals(messaging_group_id);
  `);

  // ── From 012-channel-registration ──
  // messaging_groups.denied_at already included above (column present from
  // creation). pending_channel_approvals includes title + options_json (013).

  await client.query(`
    CREATE TABLE IF NOT EXISTS pending_channel_approvals (
      messaging_group_id   TEXT PRIMARY KEY REFERENCES messaging_groups(id),
      agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
      original_message     TEXT NOT NULL,
      approver_user_id     TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      title                TEXT NOT NULL DEFAULT '',
      options_json         TEXT NOT NULL DEFAULT '[]'
    );
  `);

  // ── Backfill schema_version with all 11 upstream migration names ──
  // Uses ON CONFLICT (name) DO NOTHING so re-runs are fully idempotent (M1).

  const appliedAt = new Date().toISOString();
  for (let i = 0; i < UPSTREAM_MIGRATION_NAMES.length; i++) {
    await client.query(
      `INSERT INTO schema_version (version, name, applied)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING`,
      [i + 1, UPSTREAM_MIGRATION_NAMES[i], appliedAt],
    );
  }
}

export const migrationPostgresInit = {
  version: 0,
  name: 'postgres-init',
  up,
} as const;
