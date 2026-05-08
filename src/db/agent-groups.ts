import type { AgentGroup } from '../types.js';
import { get, all, run } from './connection.js';

export async function createAgentGroup(group: AgentGroup): Promise<void> {
  await run(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [group.id, group.name, group.folder, group.agent_provider, group.created_at],
  );
}

export async function getAgentGroup(id: string): Promise<AgentGroup | undefined> {
  return get<AgentGroup>('SELECT * FROM agent_groups WHERE id = $1', [id]);
}

export async function getAgentGroupByFolder(folder: string): Promise<AgentGroup | undefined> {
  return get<AgentGroup>('SELECT * FROM agent_groups WHERE folder = $1', [folder]);
}

export async function getAllAgentGroups(): Promise<AgentGroup[]> {
  return all<AgentGroup>('SELECT * FROM agent_groups ORDER BY name');
}

export async function updateAgentGroup(
  id: string,
  updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider'>>,
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
  await run(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
}

export async function deleteAgentGroup(id: string): Promise<void> {
  await run('DELETE FROM agent_groups WHERE id = $1', [id]);
}
