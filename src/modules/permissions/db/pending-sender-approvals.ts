/**
 * CRUD for pending_sender_approvals — the in-flight state for the
 * request_approval unknown-sender flow.
 */
import { get, run } from '../../../db/connection.js';

export interface PendingSenderApproval {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  sender_identity: string;
  sender_name: string | null;
  original_message: string;
  approver_user_id: string;
  created_at: string;
  /** Card title shown at creation and re-used by getAskQuestionRender on click. */
  title: string;
  /** Normalized options (JSON-encoded NormalizedOption[]) — same shape persisted on pending_approvals. */
  options_json: string;
}

export async function createPendingSenderApproval(row: PendingSenderApproval): Promise<void> {
  await run(
    `INSERT INTO pending_sender_approvals (
       id, messaging_group_id, agent_group_id, sender_identity,
       sender_name, original_message, approver_user_id, created_at,
       title, options_json
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      row.id,
      row.messaging_group_id,
      row.agent_group_id,
      row.sender_identity,
      row.sender_name,
      row.original_message,
      row.approver_user_id,
      row.created_at,
      row.title,
      row.options_json,
    ],
  );
}

export async function getPendingSenderApproval(id: string): Promise<PendingSenderApproval | undefined> {
  return get<PendingSenderApproval>('SELECT * FROM pending_sender_approvals WHERE id = $1', [id]);
}

export async function hasInFlightSenderApproval(messagingGroupId: string, senderIdentity: string): Promise<boolean> {
  const row = await get<{ x: number }>(
    'SELECT 1 AS x FROM pending_sender_approvals WHERE messaging_group_id = $1 AND sender_identity = $2',
    [messagingGroupId, senderIdentity],
  );
  return row !== undefined;
}

export async function deletePendingSenderApproval(id: string): Promise<void> {
  await run('DELETE FROM pending_sender_approvals WHERE id = $1', [id]);
}
