import type { UserDm } from '../../../types.js';
import { get, all, run } from '../../../db/connection.js';

export async function upsertUserDm(row: UserDm): Promise<void> {
  await run(
    `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(user_id, channel_type) DO UPDATE SET
       messaging_group_id = excluded.messaging_group_id,
       resolved_at = excluded.resolved_at`,
    [row.user_id, row.channel_type, row.messaging_group_id, row.resolved_at],
  );
}

export async function getUserDm(userId: string, channelType: string): Promise<UserDm | undefined> {
  return get<UserDm>('SELECT * FROM user_dms WHERE user_id = $1 AND channel_type = $2', [userId, channelType]);
}

export async function getUserDmsForUser(userId: string): Promise<UserDm[]> {
  return all<UserDm>('SELECT * FROM user_dms WHERE user_id = $1', [userId]);
}

export async function deleteUserDm(userId: string, channelType: string): Promise<void> {
  await run('DELETE FROM user_dms WHERE user_id = $1 AND channel_type = $2', [userId, channelType]);
}
