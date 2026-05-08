/**
 * Integration tests for the unknown-channel registration flow (ACTION-ITEMS
 * item 22).
 *
 * Covers:
 *  - Mention on an unwired channel fires an owner-approval card
 *  - DM on an unwired channel fires a card (engage_mode will default to pattern='.')
 *  - In-flight dedup: second mention while a card is pending doesn't spam
 *  - Approve: wiring created with correct defaults, triggering sender added
 *    as member, replay wakes the container
 *  - Deny: messaging_groups.denied_at set, future mentions drop silently
 *  - Unauthorized clicker is rejected (same pattern as sender-approval)
 *  - No-owner install: no card, no row
 *  - No agent groups configured: no card, no row
 */
import fs from 'fs';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

// Mock container runner — prevent actual docker spawn.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock delivery adapter.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-channel-approval' };
});

const TEST_DIR = '/tmp/nanoclaw-test-channel-approval';

function now() {
  return new Date().toISOString();
}

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer().start();
  pool = initTestDb({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
  });
  await runMigrations(pool);
}, 120_000);

afterAll(async () => {
  await closeDb();
  await container.stop();
});

// Mock ensureUserDm — look up the owner's preconfigured DM row instead of
// hitting a real openDM RPC. Uses the shared pool directly.
vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getPool } = await import('../../db/connection.js');
    const result = await getPool().query<{ id: string; channel_type: string; platform_id: string; is_group: number; unknown_sender_policy: string; created_at: string; denied_at: string | null; name: string }>(
      `SELECT mg.* FROM messaging_groups mg
         JOIN user_dms ud ON ud.messaging_group_id = mg.id
        WHERE ud.user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }),
}));

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  await import('./index.js'); // register hooks

  // Base fixtures: one agent group + owner with a DM on 'telegram'.
  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });

  await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });

  // Pre-seed owner's DM messaging group + user_dms mapping.
  await createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await pool.query(
    `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
     VALUES ($1, $2, $3, $4)`,
    ['telegram:owner', 'telegram', 'mg-dm-owner', now()],
  );

  deliverMock.mockClear();
});

afterEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  await pool.query(
    `TRUNCATE TABLE agent_groups, messaging_groups, users,
       sessions, messaging_group_agents, user_roles, agent_group_members,
       user_dms, agent_destinations, pending_approvals, pending_questions,
       pending_sender_approvals, pending_channel_approvals CASCADE`,
  );
});

function groupMention(platformId: string, text = '@bot hello') {
  return {
    channelType: 'telegram',
    platformId,
    threadId: 'thread-1', // non-null → is_group=true per channel-approval default-picker logic
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: 'caller', senderName: 'Caller', text }),
      timestamp: now(),
      isMention: true,
    },
  };
}

function dmEvent(platformId: string, text = 'hello') {
  return {
    channelType: 'telegram',
    platformId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: 'stranger', senderName: 'Stranger', text }),
      timestamp: now(),
      isMention: true, // DM bridge sets isMention=true
    },
  };
}

describe('unknown-channel registration flow', () => {
  it('delivers an approval card on mention into an unwired group', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-new'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [channel, platformId, thread, kind, content] = deliverMock.mock.calls[0];
    expect(channel).toBe('telegram');
    expect(platformId).toBe('dm-owner'); // delivered to owner's DM
    expect(thread).toBeNull();
    expect(kind).toBe('chat-sdk');
    const payload = JSON.parse(content as string);
    expect(payload.type).toBe('ask_question');
    // Single-agent card offers a direct "Connect to <name>" button.
    const connectOption = payload.options.find((o: { value: string }) => o.value.startsWith('connect:'));
    expect(connectOption).toBeDefined();
    expect(connectOption.label).toContain('Andy');

    const rows = (await pool.query('SELECT * FROM pending_channel_approvals')).rows as Array<{
      messaging_group_id: string;
    }>;
    expect(rows).toHaveLength(1);
  });

  it('delivers a card on DM too (non-threaded event)', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(dmEvent('dm-new-user'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query<{ c: number }>('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(Number(rows[0].c)).toBe(1);
  });

  it('dedups a second mention while the card is pending', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-busy'));
    await new Promise((r) => setTimeout(r, 10));
    await routeInbound(groupMention('chat-busy', '@bot still here'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query<{ c: number }>('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(Number(rows[0].c)).toBe(1);
  });

  it('approve → creates wiring, admits triggering sender, replays', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { wakeContainer } = await import('../../container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound(groupMention('chat-approve'));
    await new Promise((r) => setTimeout(r, 10));

    const { rows: pendingRows } = await pool.query<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    );
    const pending = pendingRows[0];
    expect(pending).toBeDefined();

    // Owner clicks "Connect to Andy" (single-agent card).
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-1',
        userId: 'owner', // raw platform id — handler namespaces it
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // Wiring created with defaults.
    const { rows: mgaRows } = await pool.query<{
      engage_mode: string;
      engage_pattern: string | null;
      sender_scope: string;
      ignored_message_policy: string;
      agent_group_id: string;
    }>(
      'SELECT * FROM messaging_group_agents WHERE messaging_group_id = $1',
      [pending.messaging_group_id],
    );
    const mga = mgaRows[0];
    expect(mga).toBeDefined();
    expect(mga.engage_mode).toBe('mention-sticky'); // group (threadId != null)
    expect(mga.engage_pattern).toBeNull();
    expect(mga.sender_scope).toBe('known');
    expect(mga.ignored_message_policy).toBe('accumulate');
    expect(mga.agent_group_id).toBe('ag-1');

    // Triggering sender auto-admitted so sender_scope='known' doesn't
    // bounce the replay into sender-approval.
    const { rows: memberRows } = await pool.query(
      'SELECT 1 AS x FROM agent_group_members WHERE user_id = $1 AND agent_group_id = $2',
      ['telegram:caller', 'ag-1'],
    );
    expect(memberRows[0]).toBeDefined();

    // Pending row cleared and container woken via replay.
    const { rows: stillPendingRows } = await pool.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM pending_channel_approvals',
    );
    expect(Number(stillPendingRows[0].c)).toBe(0);
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('approve on a DM wires with pattern="." defaults', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(dmEvent('dm-approve-user'));
    await new Promise((r) => setTimeout(r, 10));

    const { rows: pendingRows } = await pool.query<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    );
    const pending = pendingRows[0];

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-1',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    const { rows: mgaRows } = await pool.query<{ engage_mode: string; engage_pattern: string }>(
      'SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE messaging_group_id = $1',
      [pending.messaging_group_id],
    );
    expect(mgaRows[0].engage_mode).toBe('pattern');
    expect(mgaRows[0].engage_pattern).toBe('.');
  });

  it('deny → sets denied_at; future mentions drop silently without a second card', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(groupMention('chat-deny'));
    await new Promise((r) => setTimeout(r, 10));
    const { rows: pendingRows } = await pool.query<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    );
    const pending = pendingRows[0];

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'reject',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // denied_at set, pending row cleared, no wiring.
    const mg = await getMessagingGroupByPlatform('telegram', 'chat-deny');
    expect(mg?.denied_at).not.toBeNull();
    expect(mg?.denied_at).toBeTruthy();
    const { rows: mgaCountRows } = await pool.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = $1',
      [pending.messaging_group_id],
    );
    expect(Number(mgaCountRows[0].c)).toBe(0);

    // A follow-up mention on the denied channel: no new card, no new pending row.
    deliverMock.mockClear();
    await routeInbound(groupMention('chat-deny', '@bot please'));
    await new Promise((r) => setTimeout(r, 10));
    expect(deliverMock).not.toHaveBeenCalled();
    const { rows: stillPendingRows } = await pool.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM pending_channel_approvals',
    );
    expect(Number(stillPendingRows[0].c)).toBe(0);
  });

  it('rejects clicks from an unauthorized user (prevents self-admit via forwarded card)', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(groupMention('chat-unauth'));
    await new Promise((r) => setTimeout(r, 10));
    const { rows: pendingRows } = await pool.query<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    );
    const pending = pendingRows[0];

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'approve',
        userId: 'random-bystander',
        channelType: 'telegram',
        platformId: 'dm-random',
        threadId: null,
      });
      if (claimed) break;
    }

    // No wiring created, pending row preserved so a real approver can act on it.
    const { rows: mgaCountRows } = await pool.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = $1',
      [pending.messaging_group_id],
    );
    expect(Number(mgaCountRows[0].c)).toBe(0);
    const { rows: stillPendingRows } = await pool.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM pending_channel_approvals',
    );
    expect(Number(stillPendingRows[0].c)).toBe(1);
  });
});

describe('no-owner / no-agent failure modes', () => {
  it('no owner → no card, no pending row (fresh-install bootstrap path)', async () => {
    // Wipe the owner grant set up in the outer beforeEach.
    await pool.query('DELETE FROM user_roles');

    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-noowner'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const { rows } = await pool.query<{ c: number }>('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(Number(rows[0].c)).toBe(0);
  });

  it('no agent groups → no card, no pending row', async () => {
    // Drop everything that refs agent_groups (CASCADE handles transitivity).
    await pool.query(
      `TRUNCATE TABLE agent_groups, messaging_groups, users,
         sessions, messaging_group_agents, user_roles, agent_group_members,
         user_dms, agent_destinations, pending_approvals, pending_questions,
         pending_sender_approvals, pending_channel_approvals CASCADE`,
    );

    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-noagent'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const { rows } = await pool.query<{ c: number }>('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(Number(rows[0].c)).toBe(0);
  });
});
