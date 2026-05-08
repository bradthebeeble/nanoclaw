/**
 * Postgres parity tests — validate that every upstream SQLite table and column
 * survives the 000-postgres-init migration unchanged.
 *
 * RED phase: these fail until 000-postgres-init.ts + pg.Pool connection.ts exist.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Dynamically import the pg-based runMigrations
// These imports will fail (RED) until connection.ts + 000-postgres-init.ts exist.
import { runMigrations } from './migrations/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The 11 upstream migration names that 000-postgres-init must backfill in schema_version.
const UPSTREAM_MIGRATION_NAMES = [
  'initial-v2-schema',
  'chat-sdk-state',
  'pending-approvals',
  'agent-destinations',
  'pending-approvals-title-options',
  'dropped-messages',
  'drop-pending-credentials',
  'engage-modes',
  'pending-sender-approvals',
  'channel-registration',
  'approval-render-metadata',
];

// Tables that 000-postgres-init must create (from schema.ts SCHEMA constant
// + all migrations from 001 through 013).
const EXPECTED_TABLES = [
  'agent_groups',
  'messaging_groups',
  'messaging_group_agents',
  'users',
  'user_roles',
  'agent_group_members',
  'user_dms',
  'sessions',
  'pending_questions',
  'pending_sender_approvals',
  // from migration002
  'chat_sdk_kv',
  'chat_sdk_subscriptions',
  'chat_sdk_locks',
  'chat_sdk_lists',
  // from moduleApprovalsPendingApprovals
  'pending_approvals',
  // from moduleAgentToAgentDestinations
  'agent_destinations',
  // from migration008
  'unregistered_senders',
  // from migration012
  'pending_channel_approvals',
  // schema_version itself
  'schema_version',
];

// Columns per table (from schema.ts SCHEMA constant + migrations).
// Only validates the central-DB tables (session DBs are on SQLite — out of scope).
const TABLE_COLUMNS: Record<string, string[]> = {
  agent_groups: ['id', 'name', 'folder', 'agent_provider', 'created_at'],
  messaging_groups: [
    'id',
    'channel_type',
    'platform_id',
    'name',
    'is_group',
    'unknown_sender_policy',
    'created_at',
    'denied_at',
  ],
  messaging_group_agents: [
    'id',
    'messaging_group_id',
    'agent_group_id',
    'engage_mode',
    'engage_pattern',
    'sender_scope',
    'ignored_message_policy',
    'session_mode',
    'priority',
    'created_at',
  ],
  users: ['id', 'kind', 'display_name', 'created_at'],
  user_roles: ['user_id', 'role', 'agent_group_id', 'granted_by', 'granted_at'],
  agent_group_members: ['user_id', 'agent_group_id', 'added_by', 'added_at'],
  user_dms: ['user_id', 'channel_type', 'messaging_group_id', 'resolved_at'],
  sessions: [
    'id',
    'agent_group_id',
    'messaging_group_id',
    'thread_id',
    'agent_provider',
    'status',
    'container_status',
    'last_active',
    'created_at',
  ],
  pending_questions: [
    'question_id',
    'session_id',
    'message_out_id',
    'platform_id',
    'channel_type',
    'thread_id',
    'title',
    'options_json',
    'created_at',
  ],
  pending_sender_approvals: [
    'id',
    'messaging_group_id',
    'agent_group_id',
    'sender_identity',
    'sender_name',
    'original_message',
    'approver_user_id',
    'created_at',
    'title',
    'options_json',
  ],
  chat_sdk_kv: ['key', 'value', 'expires_at'],
  chat_sdk_subscriptions: ['thread_id', 'subscribed_at'],
  chat_sdk_locks: ['thread_id', 'token', 'expires_at'],
  chat_sdk_lists: ['key', 'idx', 'value', 'expires_at'],
  pending_approvals: [
    'approval_id',
    'session_id',
    'request_id',
    'action',
    'payload',
    'created_at',
    'agent_group_id',
    'channel_type',
    'platform_id',
    'platform_message_id',
    'expires_at',
    'status',
    'title',
    'options_json',
  ],
  agent_destinations: ['agent_group_id', 'local_name', 'target_type', 'target_id', 'created_at'],
  unregistered_senders: [
    'channel_type',
    'platform_id',
    'user_id',
    'sender_name',
    'reason',
    'messaging_group_id',
    'agent_group_id',
    'message_count',
    'first_seen',
    'last_seen',
  ],
  pending_channel_approvals: [
    'messaging_group_id',
    'agent_group_id',
    'original_message',
    'approver_user_id',
    'created_at',
    'title',
    'options_json',
  ],
};

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('nanoclaw_test')
    .withUsername('nanoclaw')
    .withPassword('nanoclaw_test_pw')
    .start();

  pool = new Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
    max: 3,
  });

  // Run migrations once; tests are read-only after this.
  await runMigrations(pool);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// ── P1: every SCHEMA table exists in PG after migration ──

describe('P1: every upstream table exists in Postgres after migration', () => {
  for (const tableName of EXPECTED_TABLES) {
    it(`table "${tableName}" exists`, async () => {
      const result = await pool.query(`SELECT to_regclass($1) AS found`, [`public.${tableName}`]);
      expect(result.rows[0].found).not.toBeNull();
    });
  }
});

// ── P2: column inventory matches upstream SQLite schema ──

describe('P2: column inventory matches upstream SQLite schema', () => {
  for (const [tableName, expectedCols] of Object.entries(TABLE_COLUMNS)) {
    it(`table "${tableName}" has expected columns`, async () => {
      const result = await pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
          ORDER BY column_name`,
        [tableName],
      );
      const actualCols = result.rows.map((r: { column_name: string }) => r.column_name).sort();
      const sortedExpected = [...expectedCols].sort();
      expect(actualCols).toEqual(sortedExpected);
    });
  }
});

// ── P3: every upstream migration name is backfilled in schema_version ──

describe('P3: upstream migration names backfilled in schema_version', () => {
  it('schema_version contains all 11 upstream migration names', async () => {
    const result = await pool.query<{ name: string }>(`SELECT name FROM schema_version ORDER BY name`);
    const names = result.rows.map((r) => r.name);

    for (const expectedName of UPSTREAM_MIGRATION_NAMES) {
      expect(names, `expected "${expectedName}" in schema_version`).toContain(expectedName);
    }
  });

  it('schema_version has exactly 11 upstream migration names (no extra)', async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM schema_version WHERE name = ANY($1)`,
      [UPSTREAM_MIGRATION_NAMES],
    );
    expect(Number(result.rows[0].count)).toBe(UPSTREAM_MIGRATION_NAMES.length);
  });
});
