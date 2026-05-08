import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],

    // Run test files sequentially so each file's testcontainer/pg.Pool
    // singleton doesn't stomp on another file's pool mid-run.
    // The central-DB pool (_pool in connection.ts) is a module singleton —
    // parallel files racing on initTestDb() / closeDb() corrupt each other.
    fileParallelism: false,
  },
});
