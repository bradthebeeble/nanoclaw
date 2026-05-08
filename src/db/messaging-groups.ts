import type { MessagingGroup, MessagingGroupAgent } from '../types.js';
// Transitional tier violation: core imports from optional agent-to-agent module.
// `createMessagingGroupAgent` auto-creates a destination row on wiring — the
// two concerns are currently bundled. When agent-to-agent isn't installed,
// the table doesn't exist and this import chain remains dormant because
// `createMessagingGroupAgent` is only called from setup/admin paths that
// also only run when wiring channels to agents (which implicitly requires
// agent-to-agent for the destination ACL to mean anything). A cleaner split
// (or making the destination side effect module-owned) is tracked in the
// refactor plan.
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
  normalizeName,
} from '../modules/agent-to-agent/db/agent-destinations.js';
import { get, all, run, hasTable } from './connection.js';

// ── Messaging Groups ──

export async function createMessagingGroup(group: MessagingGroup): Promise<void> {
  await run(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      group.id,
      group.channel_type,
      group.platform_id,
      group.name,
      group.is_group,
      group.unknown_sender_policy,
      group.created_at,
    ],
  );
}

export async function getMessagingGroup(id: string): Promise<MessagingGroup | undefined> {
  return get<MessagingGroup>('SELECT * FROM messaging_groups WHERE id = $1', [id]);
}

export async function getMessagingGroupByPlatform(
  channelType: string,
  platformId: string,
): Promise<MessagingGroup | undefined> {
  return get<MessagingGroup>('SELECT * FROM messaging_groups WHERE channel_type = $1 AND platform_id = $2', [
    channelType,
    platformId,
  ]);
}

/**
 * Combined lookup for the router's fast-drop path. Returns the messaging
 * group (if it exists) and a count of wired agents in one query — lets
 * `routeInbound` short-circuit messages for unwired / unknown channels
 * with a single DB read instead of four.
 *
 * Returns `null` when no messaging_groups row exists for this channel.
 * Returns `{ mg, agentCount: 0 }` when the row exists but has no wired agents.
 */
export async function getMessagingGroupWithAgentCount(
  channelType: string,
  platformId: string,
): Promise<{ mg: MessagingGroup; agentCount: number } | null> {
  const row = await get<MessagingGroup & { agent_count: number }>(
    `SELECT mg.*, COUNT(mga.id) AS agent_count
       FROM messaging_groups mg
  LEFT JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
      WHERE mg.channel_type = $1 AND mg.platform_id = $2
   GROUP BY mg.id`,
    [channelType, platformId],
  );
  if (!row) return null;
  const { agent_count, ...mg } = row;
  return { mg: mg as MessagingGroup, agentCount: Number(agent_count) };
}

export async function getAllMessagingGroups(): Promise<MessagingGroup[]> {
  return all<MessagingGroup>('SELECT * FROM messaging_groups ORDER BY name');
}

export async function getMessagingGroupsByChannel(channelType: string): Promise<MessagingGroup[]> {
  return all<MessagingGroup>('SELECT * FROM messaging_groups WHERE channel_type = $1', [channelType]);
}

export async function updateMessagingGroup(
  id: string,
  updates: Partial<Pick<MessagingGroup, 'name' | 'is_group' | 'unknown_sender_policy'>>,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = $${values.length + 1}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;

  values.push(id);
  await run(`UPDATE messaging_groups SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
}

export async function deleteMessagingGroup(id: string): Promise<void> {
  await run('DELETE FROM messaging_groups WHERE id = $1', [id]);
}

/**
 * Mark a messaging group as denied by the owner (channel-registration flow).
 */
export async function setMessagingGroupDeniedAt(id: string, deniedAt: string | null): Promise<void> {
  await run('UPDATE messaging_groups SET denied_at = $1 WHERE id = $2', [deniedAt, id]);
}

// ── Messaging Group Agents ──

/**
 * Wire a messaging group to an agent group. Also auto-creates the matching
 * `agent_destinations` row so the agent can deliver to this chat as a
 * target, not just reply to the origin.
 */
export async function createMessagingGroupAgent(mga: MessagingGroupAgent): Promise<void> {
  await run(
    `INSERT INTO messaging_group_agents (
       id, messaging_group_id, agent_group_id,
       engage_mode, engage_pattern, sender_scope, ignored_message_policy,
       session_mode, priority, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      mga.id,
      mga.messaging_group_id,
      mga.agent_group_id,
      mga.engage_mode,
      mga.engage_pattern,
      mga.sender_scope,
      mga.ignored_message_policy,
      mga.session_mode,
      mga.priority,
      mga.created_at,
    ],
  );

  // Auto-create an agent_destinations row so delivery's ACL doesn't block
  // outbound messages that target this chat. Guarded: when the agent-to-agent
  // module isn't installed the table doesn't exist — skip silently.
  //
  // ⚠️  DESTINATION PROJECTION NOTE: this function only writes the central
  // `agent_destinations` row. It does NOT project into any running
  // agent's session inbound.db (see top-of-file invariant in
  // src/modules/agent-to-agent/db/agent-destinations.ts). In practice this
  // is fine because the only real callers are one-shot setup scripts
  // (setup/register.ts, scripts/init-first-agent.ts, /manage-channels
  // skill) that run in a separate process from the host.
  if (!(await hasTable('agent_destinations'))) return;

  const existing = await getDestinationByTarget(mga.agent_group_id, 'channel', mga.messaging_group_id);
  if (existing) return;

  const mg = await getMessagingGroup(mga.messaging_group_id);
  if (!mg) return;

  const base = normalizeName(mg.name || `${mg.channel_type}-${mga.messaging_group_id.slice(0, 8)}`);
  let localName = base;
  let suffix = 2;
  while (await getDestinationByName(mga.agent_group_id, localName)) {
    localName = `${base}-${suffix}`;
    suffix++;
  }

  await createDestination({
    agent_group_id: mga.agent_group_id,
    local_name: localName,
    target_type: 'channel',
    target_id: mga.messaging_group_id,
    created_at: mga.created_at,
  });
}

export async function getMessagingGroupAgents(messagingGroupId: string): Promise<MessagingGroupAgent[]> {
  return all<MessagingGroupAgent>(
    'SELECT * FROM messaging_group_agents WHERE messaging_group_id = $1 ORDER BY priority DESC',
    [messagingGroupId],
  );
}

export async function getMessagingGroupAgentByPair(
  messagingGroupId: string,
  agentGroupId: string,
): Promise<MessagingGroupAgent | undefined> {
  return get<MessagingGroupAgent>(
    'SELECT * FROM messaging_group_agents WHERE messaging_group_id = $1 AND agent_group_id = $2',
    [messagingGroupId, agentGroupId],
  );
}

export async function getMessagingGroupAgent(id: string): Promise<MessagingGroupAgent | undefined> {
  return get<MessagingGroupAgent>('SELECT * FROM messaging_group_agents WHERE id = $1', [id]);
}

export async function updateMessagingGroupAgent(
  id: string,
  updates: Partial<
    Pick<
      MessagingGroupAgent,
      'engage_mode' | 'engage_pattern' | 'sender_scope' | 'ignored_message_policy' | 'session_mode' | 'priority'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = $${values.length + 1}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;

  values.push(id);
  await run(`UPDATE messaging_group_agents SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
}

export async function deleteMessagingGroupAgent(id: string): Promise<void> {
  await run('DELETE FROM messaging_group_agents WHERE id = $1', [id]);
}

/** Get all messaging groups wired to an agent group (reverse lookup). */
export async function getMessagingGroupsByAgentGroup(agentGroupId: string): Promise<MessagingGroup[]> {
  return all<MessagingGroup>(
    `SELECT mg.* FROM messaging_groups mg
     JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
     WHERE mga.agent_group_id = $1`,
    [agentGroupId],
  );
}
