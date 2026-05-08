/**
 * Per-agent destination map + ACL.
 *
 * Each row means: agent `agent_group_id` is allowed to send messages to
 * target (`target_type`, `target_id`), and refers to it locally as `local_name`.
 *
 * Names are local to each source agent — they exist only inside that agent's
 * namespace. The host uses this table both for routing (resolve name → ID)
 * and for permission checks (row exists ⇒ authorized).
 */
/**
 * ⚠️  DESTINATION PROJECTION INVARIANT — READ BEFORE ADDING NEW CALL SITES.
 *
 * `agent_destinations` in the central DB is the source of truth, but the
 * agent-runner container reads its destinations from a per-session
 * projection in `inbound.db`. That projection is written by
 * `writeDestinations(agentGroupId, sessionId)` in session-manager.ts.
 *
 * `spawnContainer` calls `writeDestinations` on every container wake, so a
 * fresh container always sees the latest destinations. BUT: a container
 * that is ALREADY running when you mutate the central table will keep
 * serving the stale projection until its next wake — the central write
 * does not propagate automatically.
 *
 * **Therefore: every time you call `createDestination` / `deleteDestination` /
 * `deleteAllDestinationsTouching` from code that runs while an agent's
 * container may be alive, you MUST also call `writeDestinations(agentGroupId,
 * sessionId)` for each affected session.** Forgetting this manifests as
 * "dropped: unknown destination" errors at send_message time.
 *
 * Affected call sites today (keep this list honest if you add more):
 *   - src/delivery.ts::handleSystemAction case 'create_agent'
 *   - src/db/messaging-groups.ts::createMessagingGroupAgent
 */
import type { AgentDestination } from '../../../types.js';
import { get, all, run } from '../../../db/connection.js';

/**
 * ⚠️  Caller responsibility: after this returns, call
 * `writeDestinations(row.agent_group_id, <sessionId>)` for each active
 * session of that agent group so the change propagates to the running
 * container's inbound.db. See the top-of-file invariant.
 */
export async function createDestination(row: AgentDestination): Promise<void> {
  await run(
    `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [row.agent_group_id, row.local_name, row.target_type, row.target_id, row.created_at],
  );
}

export async function getDestinations(agentGroupId: string): Promise<AgentDestination[]> {
  return all<AgentDestination>(
    'SELECT * FROM agent_destinations WHERE agent_group_id = $1',
    [agentGroupId],
  );
}

export async function getDestinationByName(agentGroupId: string, localName: string): Promise<AgentDestination | undefined> {
  return get<AgentDestination>(
    'SELECT * FROM agent_destinations WHERE agent_group_id = $1 AND local_name = $2',
    [agentGroupId, localName],
  );
}

/** Reverse lookup: what does this agent call the given target? */
export async function getDestinationByTarget(
  agentGroupId: string,
  targetType: 'channel' | 'agent',
  targetId: string,
): Promise<AgentDestination | undefined> {
  return get<AgentDestination>(
    'SELECT * FROM agent_destinations WHERE agent_group_id = $1 AND target_type = $2 AND target_id = $3',
    [agentGroupId, targetType, targetId],
  );
}

/** Permission check: can this agent send to this target? */
export async function hasDestination(agentGroupId: string, targetType: 'channel' | 'agent', targetId: string): Promise<boolean> {
  const row = await get(
    'SELECT 1 FROM agent_destinations WHERE agent_group_id = $1 AND target_type = $2 AND target_id = $3 LIMIT 1',
    [agentGroupId, targetType, targetId],
  );
  return !!row;
}

/**
 * ⚠️  Caller responsibility: after this returns, call
 * `writeDestinations(agentGroupId, <sessionId>)` for each active session
 * so the deletion propagates to the running container's inbound.db.
 */
export async function deleteDestination(agentGroupId: string, localName: string): Promise<void> {
  await run(
    'DELETE FROM agent_destinations WHERE agent_group_id = $1 AND local_name = $2',
    [agentGroupId, localName],
  );
}

/**
 * Delete every destination row where this agent group is either the owner
 * or the target.
 */
export async function deleteAllDestinationsTouching(agentGroupId: string): Promise<void> {
  await run(
    'DELETE FROM agent_destinations WHERE agent_group_id = $1 OR (target_type = $2 AND target_id = $3)',
    [agentGroupId, 'agent', agentGroupId],
  );
}

/**
 * Return the list of agent_group_ids that currently have a destination
 * row pointing at `targetAgentGroupId`.
 */
export async function getDestinationReferencers(targetAgentGroupId: string): Promise<string[]> {
  const rows = await all<{ agent_group_id: string }>(
    "SELECT DISTINCT agent_group_id FROM agent_destinations WHERE target_type = 'agent' AND target_id = $1 AND agent_group_id != $2",
    [targetAgentGroupId, targetAgentGroupId],
  );
  return rows.map((r) => r.agent_group_id);
}

/** Normalize a human-readable name into a lowercase, dash-separated identifier. */
export function normalizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}
