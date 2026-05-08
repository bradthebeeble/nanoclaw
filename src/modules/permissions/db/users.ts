import type { User } from '../../../types.js';
import { get, all, run } from '../../../db/connection.js';

export async function createUser(user: User): Promise<void> {
  await run(
    `INSERT INTO users (id, kind, display_name, created_at)
     VALUES ($1, $2, $3, $4)`,
    [user.id, user.kind, user.display_name, user.created_at],
  );
}

export async function upsertUser(user: User): Promise<void> {
  await run(
    `INSERT INTO users (id, kind, display_name, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(id) DO UPDATE SET
       display_name = COALESCE(excluded.display_name, users.display_name)`,
    [user.id, user.kind, user.display_name, user.created_at],
  );
}

export async function getUser(id: string): Promise<User | undefined> {
  return get<User>('SELECT * FROM users WHERE id = $1', [id]);
}

export async function getAllUsers(): Promise<User[]> {
  return all<User>('SELECT * FROM users ORDER BY created_at');
}

export async function updateDisplayName(id: string, displayName: string): Promise<void> {
  await run('UPDATE users SET display_name = $1 WHERE id = $2', [displayName, id]);
}

export async function deleteUser(id: string): Promise<void> {
  await run('DELETE FROM users WHERE id = $1', [id]);
}
