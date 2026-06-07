import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues, pairGroups } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pairGroupService } from "../services/pair-groups.ts";
import {
  pairRoundOrchestrator,
  type PairTurnExecutor,
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

  async function seedIssue(): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Pair candidate",
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });
    return id;
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
