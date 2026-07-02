import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, issues, pairGroups } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pairGroupService } from "../services/pair-groups.ts";
import {
  pairRoundOrchestrator,
  type PairTurnExecutor,
  type PairTurnRequest,
} from "../services/pair-round-orchestrator.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-32 pair-round orchestrator embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-32 PairGroup round orchestrator (P2 §3 driver loop)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof pairGroupService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let ownerId: string;
  let counterpartId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc32-pair-orchestrator-");
    db = createDb(tempDb.connectionString);
    svc = pairGroupService(db);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    ownerId = randomUUID();
    counterpartId = randomUUID();
    await db.insert(agents).values([
      { id: ownerId, companyId, name: "Owner", role: "planner", status: "idle", adapter: "claude_local" },
      { id: counterpartId, companyId, name: "CP", role: "engineer", status: "idle", adapter: "claude_local" },
    ]);
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, issues, pair_groups, pair_turns, activity_log restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(status: string = "todo"): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Pair candidate",
      status,
      priority: "medium",
      workMode: "standard",
    });
    return id;
  }

  async function getIssueStatus(issueId: string): Promise<string | null> {
    const rows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    return rows[0]?.status ?? null;
  }

  async function listStatusChangedActivity(issueId: string) {
    return db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.status_changed"),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
        ),
      );
  }

  it("runRound records owner + counterpart turns and advances the round counter", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 5,
    });

    const executor: PairTurnExecutor = vi.fn(async (req) => ({
      summary: `${req.role}-r${req.round}`,
      outcome: "delivered",
      costCents: 25,
    }));
    const orchestrator = pairRoundOrchestrator(db, executor);

    const result = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(result.skipped).toBe(false);
    expect(result.turns).toHaveLength(2);
    expect(result.group.currentRound).toBe(1);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("round-2 owner receives the counterpart's latest review as previousTurnSummary", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 5,
    });

    const requests: PairTurnRequest[] = [];
    const executor: PairTurnExecutor = vi.fn(async (req) => {
      requests.push(req);
      return { summary: `${req.role}-r${req.round}`, outcome: "delivered" as const };
    });
    const orchestrator = pairRoundOrchestrator(db, executor);

    await orchestrator.runRound({ companyId, pairGroupId: group.id });
    await orchestrator.runRound({ companyId, pairGroupId: group.id });

    expect(requests).toHaveLength(4);
    // Round 1 owner: no counterpart review exists yet.
    expect(requests[0]).toMatchObject({ role: "owner", round: 0, previousTurnSummary: null });
    expect(requests[0].recentTurns).toEqual([]);
    // Round 1 counterpart: gets the owner's proposal; history excludes the
    // just-recorded owner turn (it was queried before the owner turn landed).
    expect(requests[1]).toMatchObject({
      role: "counterpart",
      round: 0,
      previousTurnSummary: "owner-r0",
    });
    expect(requests[1].recentTurns).toEqual([]);
    // Round 2 owner: now receives the counterpart's round-1 review (this was
    // previously hard-coded to null, so the owner re-proposed blind).
    expect(requests[2]).toMatchObject({
      role: "owner",
      round: 1,
      previousTurnSummary: "counterpart-r0",
    });
    // Both round-2 actors share the same oldest-first history of round 1.
    expect(requests[2].recentTurns).toEqual([
      { round: 0, role: "owner", outcome: "delivered", summary: "owner-r0" },
      { round: 0, role: "counterpart", outcome: "delivered", summary: "counterpart-r0" },
    ]);
    expect(requests[3].recentTurns).toEqual(requests[2].recentTurns);
  });

  it("recentTurns is capped at the most recent 6 turns, oldest first", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 10,
    });

    const requests: PairTurnRequest[] = [];
    const executor: PairTurnExecutor = vi.fn(async (req) => {
      requests.push(req);
      return { summary: `${req.role}-r${req.round}`, outcome: "delivered" as const };
    });
    const orchestrator = pairRoundOrchestrator(db, executor);

    // 5 rounds → the round-5 owner request (index 8) has 8 prior turns
    // (rounds 0..3 × 2 actors) and must carry only the last 6, oldest first.
    await orchestrator.runUntilStop({ companyId, pairGroupId: group.id, maxRoundsToRun: 5 });
    expect(requests).toHaveLength(10);
    const round5Owner = requests[8];
    expect(round5Owner.role).toBe("owner");
    expect(round5Owner.round).toBe(4);
    expect(round5Owner.recentTurns).toHaveLength(6);
    expect(round5Owner.recentTurns!.map((t) => `${t.role}-r${t.round}`)).toEqual([
      "owner-r1",
      "counterpart-r1",
      "owner-r2",
      "counterpart-r2",
      "owner-r3",
      "counterpart-r3",
    ]);
  });

  it("convergence default-ON: a group WITHOUT a stopPolicy completes when the counterpart signs off", async () => {
    const issueId = await seedIssue();
    // No stopPolicy — convergence must still fire (default ON, opt-out only).
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
    });

    const executor: PairTurnExecutor = vi.fn(async (req) => ({
      summary: req.role,
      outcome: req.role === "owner" ? ("delivered" as const) : ("no_change" as const),
    }));
    const orchestrator = pairRoundOrchestrator(db, executor);

    const result = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(result.stoppedAfter).toBe("counterpart");
    expect(result.group.status).toBe("completed");
    expect(result.group.stopReason).toBe("convergence_reached");
  });

  it("requireConvergence:false keeps the group active through a no_change counterpart turn", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      stopPolicy: { requireConvergence: false },
    });

    const executor: PairTurnExecutor = vi.fn(async (req) => ({
      summary: req.role,
      outcome: req.role === "owner" ? ("delivered" as const) : ("no_change" as const),
    }));
    const orchestrator = pairRoundOrchestrator(db, executor);

    const result = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(result.stoppedAfter).toBeNull();
    expect(result.group.status).toBe("active");
    expect(result.group.currentRound).toBe(1); // round advanced, no stop
  });

  it("bidirectional sign-off: an owner no_change on the counterpart's prior delivered work ends the round mid-way (stoppedAfter=owner, completed)", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 5,
    });

    // Round 1 (round=0): owner delivers, counterpart directly improves and
    // delivers. Round 2 (round=1): the owner reviews the counterpart's result
    // and signs off with no_change — convergence must fire IMMEDIATELY, so the
    // orchestrator returns stoppedAfter:"owner" without a counterpart turn.
    const executor: PairTurnExecutor = vi.fn(async (req) => {
      if (req.round === 0) {
        return {
          summary: req.role === "owner" ? "Plan v1" : "Improved the plan directly",
          outcome: "delivered" as const,
        };
      }
      return { summary: "Counterpart's work completes the issue", outcome: "no_change" as const };
    });
    const orchestrator = pairRoundOrchestrator(db, executor);

    const round1 = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(round1.stoppedAfter).toBeNull();
    expect(round1.group.status).toBe("active");

    const round2 = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(round2.stoppedAfter).toBe("owner");
    expect(round2.group.status).toBe("completed");
    expect(round2.group.stopReason).toBe("convergence_reached");
    expect(round2.turns).toHaveLength(1); // owner sign-off only
    expect(executor).toHaveBeenCalledTimes(3); // 2 (round 1) + 1 (round-2 owner) — no round-2 counterpart
  });

  it("runRound short-circuits when the owner aborts", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
    });

    const executor: PairTurnExecutor = vi.fn(async () => ({
      summary: "owner-aborts",
      outcome: "abort",
    }));
    const orchestrator = pairRoundOrchestrator(db, executor);

    const result = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(result.skipped).toBe(false);
    expect(result.stoppedAfter).toBe("owner");
    expect(result.group.status).toBe("aborted");
    expect(executor).toHaveBeenCalledTimes(1); // counterpart never called
  });

  it("runRound auto-completes on convergence (owner delivers, counterpart no_change with requireConvergence)", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      stopPolicy: { requireConvergence: true },
    });

    const executor: PairTurnExecutor = vi.fn(async (req) => ({
      summary: req.role,
      outcome: req.role === "owner" ? "delivered" : "no_change",
    }));
    const orchestrator = pairRoundOrchestrator(db, executor);

    const result = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(result.stoppedAfter).toBe("counterpart");
    expect(result.group.status).toBe("completed");
    expect(result.group.stopReason).toBe("convergence_reached");
  });

  it("runRound skips when group already stopped or participants missing", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId });
    // No participants → skipped.
    const executor: PairTurnExecutor = vi.fn();
    const orchestrator = pairRoundOrchestrator(db, executor);
    const skipped = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(skipped.skipped).toBe(true);
    expect(skipped.reason).toMatch(/missing participants/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("runUntilStop runs multiple rounds until stop or cap", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 10,
    });
    const executor: PairTurnExecutor = vi.fn(async (req) => ({
      summary: `${req.role}-r${req.round}`,
      outcome: "delivered",
    }));
    const orchestrator = pairRoundOrchestrator(db, executor);

    const results = await orchestrator.runUntilStop({
      companyId,
      pairGroupId: group.id,
      maxRoundsToRun: 3,
    });
    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.skipped)).toBe(true);
    expect(executor).toHaveBeenCalledTimes(6); // 3 rounds × 2 actors
    const refreshed = await svc.getById(companyId, group.id);
    expect(refreshed?.currentRound).toBe(3);
    expect(refreshed?.status).toBe("active");
  });

  it("route POST /pair-groups/:id/run-round drives the orchestrator end-to-end", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
    });

    // Build an app that wires the route with a deterministic executor.
    const { pairGroupRoutes } = await vi.importActual<
      typeof import("../routes/pair-groups.js")
    >("../routes/pair-groups.js");
    const { errorHandler } = await vi.importActual<
      typeof import("../middleware/index.js")
    >("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use(
      "/api",
      pairGroupRoutes(db, {
        pairTurnExecutor: async (req) => ({
          summary: `route-${req.role}-r${req.round}`,
          outcome: "delivered",
        }),
      }),
    );
    app.use(errorHandler);

    const res = await request(app).post(`/api/pair-groups/${group.id}/run-round`).send({ maxRoundsToRun: 2 });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results.every((r: any) => !r.skipped)).toBe(true);
  });

  it("route rejects a second run-round with 409 pair_round_in_flight while the first is still running, then allows a rerun", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 10,
    });

    // Executor whose FIRST turn blocks until we release it, so the first
    // request deterministically holds the in-flight registry slot while the
    // second request arrives.
    let signalFirstTurnStarted!: () => void;
    const firstTurnStarted = new Promise<void>((resolve) => {
      signalFirstTurnStarted = resolve;
    });
    let releaseFirstTurn!: () => void;
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    let executorCalls = 0;
    const executor: PairTurnExecutor = async (req) => {
      executorCalls += 1;
      if (executorCalls === 1) {
        signalFirstTurnStarted();
        await firstTurnGate;
      }
      return { summary: `${req.role}-r${req.round}`, outcome: "delivered" };
    };

    const { pairGroupRoutes } = await vi.importActual<
      typeof import("../routes/pair-groups.js")
    >("../routes/pair-groups.js");
    const { errorHandler } = await vi.importActual<
      typeof import("../middleware/index.js")
    >("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", pairGroupRoutes(db, { pairTurnExecutor: executor }));
    app.use(errorHandler);

    // Fire the first request (slow round) without awaiting it.
    const firstResponse = request(app)
      .post(`/api/pair-groups/${group.id}/run-round`)
      .send({ maxRoundsToRun: 1 })
      .then((res) => res);
    await firstTurnStarted;

    // While round 1 is in flight, a second run-round must 409 — the
    // registry guard fires BEFORE the executor, so no duplicate LLM spend.
    const conflict = await request(app)
      .post(`/api/pair-groups/${group.id}/run-round`)
      .send({ maxRoundsToRun: 1 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("pair_round_in_flight");
    expect(executorCalls).toBe(1); // owner turn of the FIRST call only

    // Let the first round finish: it completes normally.
    releaseFirstTurn();
    const first = await firstResponse;
    expect(first.status).toBe(200);
    expect(first.body.results).toHaveLength(1);

    // The registry slot was released in finally — a rerun now succeeds.
    const rerun = await request(app)
      .post(`/api/pair-groups/${group.id}/run-round`)
      .send({ maxRoundsToRun: 1 });
    expect(rerun.status).toBe(200);
    expect(rerun.body.results).toHaveLength(1);
    expect(executorCalls).toBe(4); // 2 rounds × 2 actors, no duplicates
  });

  it("route returns 503 when no executor is configured", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
    });

    const { pairGroupRoutes } = await vi.importActual<
      typeof import("../routes/pair-groups.js")
    >("../routes/pair-groups.js");
    const { errorHandler } = await vi.importActual<
      typeof import("../middleware/index.js")
    >("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    // No pairTurnExecutor — the default executor throws.
    app.use("/api", pairGroupRoutes(db));
    app.use(errorHandler);

    const res = await request(app).post(`/api/pair-groups/${group.id}/run-round`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/no pair turn executor/);
  });

  it("auto-start: runRound flips a todo issue to in_progress and logs issue.status_changed", async () => {
    const issueId = await seedIssue("todo");
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 5,
    });

    const executor: PairTurnExecutor = vi.fn(async (req) => ({
      summary: `${req.role}-r${req.round}`,
      outcome: "delivered",
    }));
    const orchestrator = pairRoundOrchestrator(db, executor);

    const result = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(result.skipped).toBe(false);
    expect(await getIssueStatus(issueId)).toBe("in_progress");

    const rows = await listStatusChangedActivity(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe("system");
    expect(rows[0].details).toMatchObject({
      from: "todo",
      to: "in_progress",
      autoStarted: "pair_round",
      pairGroupId: group.id,
    });

    // Idempotent: a second round does not re-transition or re-log.
    await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(await getIssueStatus(issueId)).toBe("in_progress");
    expect(await listStatusChangedActivity(issueId)).toHaveLength(1);
  });

  it("auto-start: runRound also picks up a backlog issue (pair group = explicit work order)", async () => {
    const issueId = await seedIssue("backlog");
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 5,
    });
    const orchestrator = pairRoundOrchestrator(db, async (req) => ({
      summary: `${req.role}-r${req.round}`,
      outcome: "delivered",
    }));

    await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(await getIssueStatus(issueId)).toBe("in_progress");
    const rows = await listStatusChangedActivity(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ from: "backlog", to: "in_progress" });
  });

  it("auto-start: an issue already in_review is left untouched by runRound", async () => {
    const issueId = await seedIssue("in_review");
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 5,
    });
    const orchestrator = pairRoundOrchestrator(db, async (req) => ({
      summary: `${req.role}-r${req.round}`,
      outcome: "delivered",
    }));

    const result = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(result.skipped).toBe(false);
    expect(await getIssueStatus(issueId)).toBe("in_review");
    expect(await listStatusChangedActivity(issueId)).toHaveLength(0);
  });

  it("WC-52: runRound at the cap aborts WITHOUT calling the executor (no extra billed turn)", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 1,
    });
    const executor: PairTurnExecutor = vi.fn(async (req) => ({
      summary: `${req.role}-r${req.round}`,
      outcome: "delivered",
      costCents: 50,
    }));
    const orchestrator = pairRoundOrchestrator(db, executor);

    // Round 0 runs (owner + counterpart = 2 executor calls), then advance → currentRound=1.
    const round0 = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(round0.stoppedAfter).toBeNull();
    expect(executor).toHaveBeenCalledTimes(2);

    // Next runRound is at currentRound=1 == cap: must abort WITHOUT calling the
    // executor again (the off-by-one bug previously ran + billed an extra owner turn).
    const capped = await orchestrator.runRound({ companyId, pairGroupId: group.id });
    expect(capped.stoppedAfter).toBe("cap");
    expect(capped.group.status).toBe("aborted");
    expect(capped.group.stopReason).toBe("max_rounds_reached");
    expect(executor).toHaveBeenCalledTimes(2); // NOT 3 — no extra owner turn

    // Ledger has exactly the 2 round-0 turns; no stray over-budget row.
    const turns = await svc.listTurnsForGroup(companyId, group.id);
    expect(turns).toHaveLength(2);
    expect(group.totalCostCents).toBe(0); // sanity: initial
    const refreshed = await svc.getById(companyId, group.id);
    expect(refreshed?.totalCostCents).toBe(100); // 2 × 50, no third
  });
});
