export const migration009 = {
  version: 9,
  name: 'drop-pending-credentials',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up: (db: any) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_pending_credentials_status;
      DROP TABLE IF EXISTS pending_credentials;
    `);
  },
};
