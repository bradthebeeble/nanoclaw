import type { AgentGroupMember } from '../../../types.js';
import { get, all, run } from '../../../db/connection.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './user-roles.js';

export async function addMember(row: AgentGroupMember): Promise<void> {
  await run(
    `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, agent_group_id) DO NOTHING`,
    [row.user_id, row.agent_group_id, row.added_by, row.added_at],
  );
}

export async function removeMember(userId: string, agentGroupId: string): Promise<void> {
  await run('DELETE FROM agent_group_members WHERE user_id = $1 AND agent_group_id = $2', [userId, agentGroupId]);
}

export async function getMembers(agentGroupId: string): Promise<AgentGroupMember[]> {
  return all<AgentGroupMember>('SELECT * FROM agent_group_members WHERE agent_group_id = $1 ORDER BY added_at', [
    agentGroupId,
  ]);
}

/**
 * Is the user "known" in this agent group?
 * Owner, global admin, and scoped admin are implicitly members.
 */
export async function isMember(userId: string, agentGroupId: string): Promise<boolean> {
  if ((await isOwner(userId)) || (await isGlobalAdmin(userId)) || (await isAdminOfAgentGroup(userId, agentGroupId))) {
    return true;
  }
  const row = await get('SELECT 1 FROM agent_group_members WHERE user_id = $1 AND agent_group_id = $2 LIMIT 1', [
    userId,
    agentGroupId,
  ]);
  return !!row;
}

/** Direct row lookup — does not honor the admin/owner implicit-membership rule. */
export async function hasMembershipRow(userId: string, agentGroupId: string): Promise<boolean> {
  const row = await get('SELECT 1 FROM agent_group_members WHERE user_id = $1 AND agent_group_id = $2 LIMIT 1', [
    userId,
    agentGroupId,
  ]);
  return !!row;
}
