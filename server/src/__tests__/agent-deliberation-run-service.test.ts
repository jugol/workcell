import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentDeliberationRuns, agentDeliberationTurns, agents, companies, createDb } from "@workcell/db";
import type { DeliberationInvoke } from "../services/agent-deliberation.js";
import {
  agentDeliberationRunService,
  reapStaleDeliberationRuns,
} from "../services/agent-deliberation-run.js";
import { buildLiveDeliberationInvoke } from "../services/deliberation-live-invoke.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// WC-209: embedded-pg tests for agentDeliberationRunService — the persistence
// layer behind the async route. Drives start()/run() with a deterministic
// buildInvoke(onCost) factory and asserts: turns persist IN ORDER, the run
// transitions running→completed, per-turn cost is SUMMED into the run total,
// and the failed path records status "failed" + error (and partial turns/cost).

process.env.WORKCELL_HOME ??= "/tmp/workcell-test-home";
process.env.WORKCELL_INSTANCE_ID ??= "vitest";
process.env.WORKCELL_LOG_DIR ??= "/tmp/workcell-test-home/logs";
process.env.WORKCELL_IN_WORKTREE ??= "false";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-209 deliberation run-service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("WC-209 agentDeliberationRunService", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  async function insertAgent() {
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "general",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc209-deliberation-run-service-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    await insertAgent();
  });

  afterEach(async () => {
    await db.execute("truncate table companies restart identity cascade" as never);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists turns in order, completes the run, and SUMS per-turn cost", async () => {
    const svc = agentDeliberationRunService(db);

    // A buildInvoke that reports a per-turn cost through onCost (the SAME seam
    // the live invoke uses). 3 cents for propose, 5 for the revise, 7 for the
    // accept → total 15. A:propose → B:revise → A:accept.
    const costByTurn = [3, 5, 7];
    let turnIndex = 0;
    const buildInvoke = (onCost: (c: number) => void): DeliberationInvoke => {
      return async ({ role, round }) => {
        // Report this turn's cost BEFORE returning, exactly as the live invoke
        // does (it bills after the adapter run, then returns the text). The
        // engine awaits invoke fully before pushing the entry, so the cost is in
        // hand when onTurn persists the turn.
        onCost(costByTurn[turnIndex] ?? 0);
        turnIndex += 1;
        if (role === "propose") return "Draft A.";
        if (round === 1) {
          return JSON.stringify({ verdict: "revise", revision: "Revised B.", feedback: "tighter" });
        }
        return JSON.stringify({ verdict: "accept" });
      };
    };

    const runId = await svc.start({
      companyId,
      agentId,
      task: "Sum the cost.",
      brainA: { model: "a" },
      brainB: { model: "b" },
      maxRounds: 4,
      buildInvoke,
    });

    // Run row: completed, accepted by A, 2 rounds, cost summed to 15.
    const [run] = await db
      .select()
      .from(agentDeliberationRuns)
      .where(eq(agentDeliberationRuns.id, runId));
    expect(run!.status).toBe("completed");
    expect(run!.acceptedBy).toBe("A");
    expect(run!.rounds).toBe(2);
    expect(run!.finalOutput).toBe("Revised B.");
    expect(run!.totalCostCents).toBe(15);
    expect(run!.completedAt).toBeTruthy();
    // The snapshotted brain config + task round-tripped.
    expect(run!.task).toBe("Sum the cost.");
    expect(run!.maxRounds).toBe(4);
    expect(run!.brainA).toMatchObject({ model: "a" });

    // Turns persisted IN ORDER with their individual costs.
    const turns = await db
      .select()
      .from(agentDeliberationTurns)
      .where(eq(agentDeliberationTurns.runId, runId))
      .orderBy(agentDeliberationTurns.round, agentDeliberationTurns.createdAt);
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => [t.round, t.brain, t.action, t.costCents])).toEqual([
      [0, "A", "propose", 3],
      [1, "B", "revise", 5],
      [2, "A", "accept", 7],
    ]);
    expect(turns[1]!.feedback).toBe("tighter");
  });

  it("getRun returns the run + ordered turns (company-scoped); cross-company → null", async () => {
    const svc = agentDeliberationRunService(db);
    const buildInvoke = (): DeliberationInvoke => async ({ role }) =>
      role === "propose" ? "p" : JSON.stringify({ verdict: "accept" });
    const runId = await svc.start({
      companyId,
      agentId,
      task: "Get me.",
      brainA: { model: "a" },
      brainB: { model: "b" },
      maxRounds: 4,
      buildInvoke,
    });

    const found = await svc.getRun(companyId, runId);
    expect(found).not.toBeNull();
    expect(found!.run.id).toBe(runId);
    expect(found!.turns.length).toBe(2); // propose + accept

    // A different company cannot read it.
    const cross = await svc.getRun(randomUUID(), runId);
    expect(cross).toBeNull();
  });

  it("records status 'failed' + error when the engine throws", async () => {
    const svc = agentDeliberationRunService(db);
    const buildInvoke = (): DeliberationInvoke => async () => {
      throw new Error("kaboom");
    };

    const runId = await svc.start({
      companyId,
      agentId,
      task: "Fail.",
      brainA: { model: "a" },
      brainB: { model: "b" },
      maxRounds: 4,
      buildInvoke,
    });

    const [run] = await db
      .select()
      .from(agentDeliberationRuns)
      .where(eq(agentDeliberationRuns.id, runId));
    expect(run!.status).toBe("failed");
    expect(run!.error).toContain("kaboom");
    expect(run!.completedAt).toBeTruthy();

    const turns = await db
      .select()
      .from(agentDeliberationTurns)
      .where(eq(agentDeliberationTurns.runId, runId));
    expect(turns).toHaveLength(0);
  });

  it("create() inserts a 'running' row WITHOUT running the loop; run() finishes it", async () => {
    const svc = agentDeliberationRunService(db);
    const buildInvoke = (): DeliberationInvoke => async ({ role }) =>
      role === "propose" ? "p0" : JSON.stringify({ verdict: "accept" });
    const input = {
      companyId,
      agentId,
      task: "Two phase.",
      brainA: { model: "a" },
      brainB: { model: "b" },
      maxRounds: 4,
      buildInvoke,
    };

    const runId = await svc.create(input);
    // After create only: status is 'running', no turns yet.
    const [created] = await db
      .select()
      .from(agentDeliberationRuns)
      .where(eq(agentDeliberationRuns.id, runId));
    expect(created!.status).toBe("running");
    expect(created!.completedAt).toBeNull();
    const turnsBefore = await db
      .select()
      .from(agentDeliberationTurns)
      .where(eq(agentDeliberationTurns.runId, runId));
    expect(turnsBefore).toHaveLength(0);

    // Now run the loop → completes.
    await svc.run(runId, input);
    const [finished] = await db
      .select()
      .from(agentDeliberationRuns)
      .where(eq(agentDeliberationRuns.id, runId));
    expect(finished!.status).toBe("completed");
    expect(finished!.acceptedBy).toBe("B");
  });

  it("listRuns returns recent runs newest-first, scoped to the agent", async () => {
    const svc = agentDeliberationRunService(db);
    const buildInvoke = (): DeliberationInvoke => async ({ role }) =>
      role === "propose" ? "p" : JSON.stringify({ verdict: "accept" });
    const base = {
      companyId,
      agentId,
      brainA: { model: "a" },
      brainB: { model: "b" },
      maxRounds: 4,
      buildInvoke,
    };
    await svc.start({ ...base, task: "first" });
    await svc.start({ ...base, task: "second" });

    const runs = await svc.listRuns(companyId, agentId, 10);
    expect(runs.length).toBe(2);
    expect(runs[0]!.task).toBe("second");
    expect(runs[1]!.task).toBe("first");
  });

  // WC-211 (finding 1 — resilience): a hung brain turn must FAIL the run, not
  // stall it forever. We drive the REAL live-invoke factory (with the bounded
  // per-turn timeout) over a fake adapter whose execute() never resolves, so the
  // turn times out, the invoke throws, the engine propagates, and the run service
  // marks the row status='failed' with the timeout message — end to end.
  it("(finding 1) a hung brain turn ends the run 'failed' with a timeout error within the bound", async () => {
    const svc = agentDeliberationRunService(db);

    // buildInvoke uses the production live factory; resolveAdapter returns an
    // adapter that hangs forever. A tiny turnTimeoutMs keeps the test fast.
    const buildInvoke = (onCost: (c: number) => void): DeliberationInvoke =>
      buildLiveDeliberationInvoke({
        agent: {
          id: agentId,
          companyId,
          name: "Builder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runIdBase: "delib-hang",
        onCost,
        turnTimeoutMs: 30,
        resolveAdapter: () => ({ execute: () => new Promise<never>(() => {}) }),
      });

    const started = Date.now();
    const runId = await svc.start({
      companyId,
      agentId,
      task: "Hang on the very first turn.",
      brainA: { adapter: "codex_local", model: null },
      brainB: { adapter: "codex_local", model: null },
      maxRounds: 4,
      buildInvoke,
    });
    // The whole run settled well within a generous bound (timeout is 30ms).
    expect(Date.now() - started).toBeLessThan(10_000);

    const [run] = await db
      .select()
      .from(agentDeliberationRuns)
      .where(eq(agentDeliberationRuns.id, runId));
    expect(run!.status).toBe("failed");
    expect(run!.error).toMatch(/timed out after/i);
    expect(run!.completedAt).toBeTruthy();

    // The propose turn never produced output, so no turns were persisted.
    const turns = await db
      .select()
      .from(agentDeliberationTurns)
      .where(eq(agentDeliberationTurns.runId, runId));
    expect(turns).toHaveLength(0);
  });

  // WC-211 (finding 3 — reaper): the boot-time orphan reaper fails stale
  // 'running' rows (server restart / stuck turn) and leaves fresh ones alone.
  it("(finding 3) reapStaleDeliberationRuns fails stale 'running' rows, leaves fresh ones", async () => {
    const olderThanMs = 20 * 60 * 1000; // 20 min

    // A STALE running run: created 30 min ago (older than the threshold).
    const staleCreatedAt = new Date(Date.now() - 30 * 60 * 1000);
    const [stale] = await db
      .insert(agentDeliberationRuns)
      .values({
        companyId,
        agentId,
        task: "stale",
        status: "running",
        createdAt: staleCreatedAt,
      })
      .returning({ id: agentDeliberationRuns.id });

    // A FRESH running run: just created (within the threshold).
    const [fresh] = await db
      .insert(agentDeliberationRuns)
      .values({
        companyId,
        agentId,
        task: "fresh",
        status: "running",
      })
      .returning({ id: agentDeliberationRuns.id });

    const result = await reapStaleDeliberationRuns(db, { olderThanMs });
    expect(result.reaped).toBe(1);

    const [staleAfter] = await db
      .select()
      .from(agentDeliberationRuns)
      .where(eq(agentDeliberationRuns.id, stale!.id));
    expect(staleAfter!.status).toBe("failed");
    expect(staleAfter!.error).toBe("abandoned (server restart or stuck turn)");
    expect(staleAfter!.completedAt).toBeTruthy();

    const [freshAfter] = await db
      .select()
      .from(agentDeliberationRuns)
      .where(eq(agentDeliberationRuns.id, fresh!.id));
    expect(freshAfter!.status).toBe("running");
    expect(freshAfter!.completedAt).toBeNull();
  });
});
