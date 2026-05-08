/**
 * CRUD for pending_channel_approvals — the in-flight state for the
 * unknown-channel registration flow.
 */
import { get, run } from '../../../db/connection.js';

export interface PendingChannelApproval {
  messaging_group_id: string;
  agent_group_id: string;
  original_message: string;
  approver_user_id: string;
  created_at: string;
  /** Card title shown at creation and re-used by getAskQuestionRender on click. */
  title: string;
  /** Normalized options (JSON-encoded NormalizedOption[]) — same shape persisted on pending_approvals. */
  options_json: string;
}

export async function createPendingChannelApproval(row: PendingChannelApproval): Promise<void> {
  await run(
    `INSERT INTO pending_channel_approvals (
       messaging_group_id, agent_group_id, original_message,
       approver_user_id, created_at, title, options_json
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      row.messaging_group_id, row.agent_group_id, row.original_message,
      row.approver_user_id, row.created_at, row.title, row.options_json,
    ],
  );
}

export async function getPendingChannelApproval(messagingGroupId: string): Promise<PendingChannelApproval | undefined> {
  return get<PendingChannelApproval>(
    'SELECT * FROM pending_channel_approvals WHERE messaging_group_id = $1',
    [messagingGroupId],
  );
}

export async function hasInFlightChannelApproval(messagingGroupId: string): Promise<boolean> {
  const row = await get<{ x: number }>(
    'SELECT 1 AS x FROM pending_channel_approvals WHERE messaging_group_id = $1',
    [messagingGroupId],
  );
  return row !== undefined;
}

export async function updatePendingChannelApprovalCard(messagingGroupId: string, title: string, optionsJson: string): Promise<void> {
  await run(
    'UPDATE pending_channel_approvals SET title = $1, options_json = $2 WHERE messaging_group_id = $3',
    [title, optionsJson, messagingGroupId],
  );
}

export async function deletePendingChannelApproval(messagingGroupId: string): Promise<void> {
  await run('DELETE FROM pending_channel_approvals WHERE messaging_group_id = $1', [messagingGroupId]);
}
