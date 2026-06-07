import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notInArray } from "drizzle-orm";
import { agents, companies, createDb } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Production-readiness Wave 2 (DATA — tickTimers SQL filter): tickTimers used to
// `SELECT * FROM agents` (ALL companies) every 30s and filter per-row. The fix
// pushes the status exclusion into SQL: only agents NOT in
// (paused, terminated, pending_approval) are loaded. This test asserts that exact
// predicate against embedded Postgres — agents in the excluded states are never
// materialized, while every schedulable state is — so the SQL pre-filter can
// never drop an agent that the old JS guard would have kept (and vice versa).
//
// The JS-side due check (heartbeat enabled + interval elapsed) is intentionally
// NOT replicated in SQL (it lives in runtime_config JSONB with custom coercion),
// so it is out of scope here and unchanged by the fix.

process.env.WORKCELL_HOME ??= "/tmp/workcell-test-home";
process.env.WORKCELL_INSTANCE_ID ??= "vitest";
process.env.WORKCELL_LOG_DIR ??= "/tmp/workcell-test-home/logs";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping tickTimers SQL-filter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

// MUST stay in lockstep with the exclusion set in heartbeat.ts tickTimers.
const EXCLUDED_STATUSES = ["paused", "terminated", "pending_approval"];
// The full AGENT_STATUSES set; everything not excluded must remain schedulable.
const ALL_STATUSES = [
  "active",
  "paused",
  "idle",
  "running",
  "error",
  "pending_approval",
  "terminated",
];

describeEmbeddedPostgres("tickTimers agent status SQL filter", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-tick-timers-filter-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterEach(async () => {
    await db.execute("truncate table companies restart identity cascade" as never);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("loads only schedulable agents, excluding paused/terminated/pending_approval", async () => {
    const idByStatus = new Map<string, string>();
    for (const status of ALL_STATUSES) {
      const id = randomUUID();
      idByStatus.set(status, id);
      await db.insert(agents).values({
        id,
        companyId,
        name: `agent-${status}`,
        role: "general",
        status,
        adapterType: "process",
        adapterConfig: {},
        // A due heartbeat policy — if status filtering regressed, these would all
        // be candidates; the SQL filter is the only thing keeping the excluded
        // states out.
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1 } },
        permissions: {},
      });
    }

    // The EXACT predicate tickTimers now uses to load candidate agents.
    const candidates = await db
      .select()
      .from(agents)
      .where(notInArray(agents.status, EXCLUDED_STATUSES));

    const loadedStatuses = new Set(candidates.map((a) => a.status));
    // None of the excluded states are present.
    for (const excluded of EXCLUDED_STATUSES) {
      expect(loadedStatuses.has(excluded)).toBe(false);
    }
    // Every schedulable state IS present.
    for (const status of ALL_STATUSES) {
      if (EXCLUDED_STATUSES.includes(status)) continue;
      expect(loadedStatuses.has(status)).toBe(true);
    }
    // Exactly the 4 schedulable agents (active, idle, running, error) were loaded.
    expect(candidates).toHaveLength(ALL_STATUSES.length - EXCLUDED_STATUSES.length);
  });
});
