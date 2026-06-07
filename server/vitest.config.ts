import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded-Postgres test DBs (startEmbeddedPostgresTestDatabase, used by
    // ~109 beforeAll hooks) need initdb + cluster start, which on Windows takes
    // 15-25s standalone and more when the stable runner executes several vitest
    // processes concurrently. The 20s vitest default tipped ~30 of these
    // otherwise-passing (in isolation) suites into "Hook timed out in 20000ms"
    // during a full `pnpm test`. Give PG setup real headroom (mcp-bridge uses 30s).
    hookTimeout: 60_000,
    testTimeout: 30_000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    poolOptions: {
      forks: {
        isolate: true,
        maxForks: 1,
        minForks: 1,
      },
    },
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
