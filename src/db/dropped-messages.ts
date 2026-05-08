import { get, all, run } from './connection.js';

export interface UnregisteredSender {
  channel_type: string;
  platform_id: string;
  user_id: string | null;
  sender_name: string | null;
  reason: string;
  messaging_group_id: string | null;
  agent_group_id: string | null;
  message_count: number;
  first_seen: string;
  last_seen: string;
}

export async function recordDroppedMessage(msg: {
  channel_type: string;
  platform_id: string;
  user_id: string | null;
  sender_name: string | null;
  reason: string;
  messaging_group_id: string | null;
  agent_group_id: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  // ON CONFLICT (channel_type, platform_id) DO UPDATE SET ... uses excluded.X
  // which is standard Postgres syntax (as verified in 01-RESEARCH.md finding 3).
  await run(
    `INSERT INTO unregistered_senders (channel_type, platform_id, user_id, sender_name, reason, messaging_group_id, agent_group_id, message_count, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)
     ON CONFLICT (channel_type, platform_id) DO UPDATE SET
       user_id = COALESCE(excluded.user_id, unregistered_senders.user_id),
       sender_name = COALESCE(excluded.sender_name, unregistered_senders.sender_name),
       reason = excluded.reason,
       message_count = unregistered_senders.message_count + 1,
       last_seen = excluded.last_seen`,
    [msg.channel_type, msg.platform_id, msg.user_id, msg.sender_name, msg.reason, msg.messaging_group_id, msg.agent_group_id, now],
  );
}

export async function getUnregisteredSenders(limit = 50): Promise<UnregisteredSender[]> {
  return all<UnregisteredSender>(
    'SELECT * FROM unregistered_senders ORDER BY last_seen DESC LIMIT $1',
    [limit],
  );
}
