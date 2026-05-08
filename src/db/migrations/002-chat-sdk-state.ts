
export const migration002 = {
  version: 2,
  name: 'chat-sdk-state',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up(db: any) {
    db.exec(`
      CREATE TABLE chat_sdk_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );

      CREATE TABLE chat_sdk_subscriptions (
        thread_id TEXT PRIMARY KEY,
        subscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE chat_sdk_locks (
        thread_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE chat_sdk_lists (
        key TEXT NOT NULL,
        idx INTEGER NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (key, idx)
      );
    `);
  },
};
