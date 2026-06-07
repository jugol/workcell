import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentDeliberationRuns,
  agentDeliberationTurns,
  agents,
  companies,
  createDb,
} from "@workcell/db";
import type { DeliberationInvoke } from "../services/agent-deliberation.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// WC-209 (deliberation async + persist): the ASYNC deliberation run route
// (POST /agents/:id/deliberate now returns 202 + runId) plus the two GET poll
// routes. Real agentRoutes against embedded Postgres, but a deterministic STUB
// DeliberationInvoke is injected via the route's options seam so the dual-brain
// engine + persistence are driven end-to-end WITHOUT any real model / CLI.
//
// With a synchronous stub the fire-and-forget run loop settles within a few
// microtasks, so a test POSTs (202), then polls GET /deliberations/:runId until
// the run reaches a terminal status — and asserts the turns persisted IN ORDER,
// the status went running→completed, and cost summed. Also covers the
// failed-path (status "failed"), the deliberation-disabled 400, the
// cross-company 403/404, the missing-agent 404, and the live-flag-off 503.

process.env.WORKCELL_HOME ??= "/tmp/workcell-test-home";
process.env.WORKCELL_INSTANCE_ID ??= "vitest";
process.env.WORKCELL_LOG_DIR ??= "/tmp/workcell-test-home/logs";
process.env.WORKCELL_IN_WORKTREE ??= "false";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-209 deliberation async route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const enabledDeliberation = {
  enabled: true,
  brainA: { model: "anthropic/claude-a" },
  brainB: { model: "openai/gpt-b" },
  maxRounds: 4,
};

// Deterministic stub: brain A proposes, brain B revises once, brain A accepts.
// Returns the engine-parseable raw text the live invoke would otherwise get
// from a real model (the engine parses the JSON verdict out of review turns).
// `state.calls` counts the brain turns so tests can assert the stub (not a real
// model) was driven.
function makeConsensusStub(): { invoke: DeliberationInvoke; state: { calls: number } } {
  const state = { calls: 0 };
  const invoke: DeliberationInvoke = async ({ role, round }) => {
    state.calls += 1;
    if (role === "propose") {
      return "Draft proposal from Brain A.";
    }
    // First review (round 1) = revise; second review (round 2) = accept.
    if (round === 1) {
      return JSON.stringify({
        verdict: "revise",
        revision: "Revised proposal from Brain B.",
        feedback: "Tightened the wording.",
      });
    }
    return JSON.stringify({ verdict: "accept" });
  };
  return { invoke, state };
}

describeEmbeddedPostgres("WC-209 agent deliberation async route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let otherCompanyId!: string;
  let agentId!: string;

  async function makeApp(
    invokeOverride?: DeliberationInvoke,
    actorOverride?: Record<string, unknown>,
  ) {
    const { agentRoutes } = await import("../routes/agents.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Default: local_implicit board actor → full access in the real
      // authorization service (same shim the config-routes test uses). Tests can
      // override to a company-scoped actor to exercise cross-company rejection.
      req.actor = (actorOverride ?? {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        companyIds: [companyId],
        isInstanceAdmin: true,
      }) as never;
      next();
    });
    app.use("/api", agentRoutes(db, { deliberationInvokeOverride: invokeOverride }));
    app.use(errorHandler);
    return app;
  }

  async function insertAgent(
    id: string,
    company: string,
    deliberation: unknown,
  ) {
    await db.insert(agents).values({
      id,
      companyId: company,
      name: "Builder",
      role: "general",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...(deliberation === undefined ? {} : { deliberation: deliberation as never }),
    });
  }

  // Poll the run GET route until the run reaches a terminal status, or the
  // attempt budget runs out. With a synchronous stub the loop settles almost
  // immediately; the budget just guards against a hang.
  async function pollRunUntilTerminal(
    app: express.Express,
    agentRef: string,
    runId: string,
    attempts = 50,
  ) {
    let last: request.Response | null = null;
    for (let i = 0; i < attempts; i += 1) {
      const res = await request(app).get(`/api/agents/${agentRef}/deliberations/${runId}`);
      last = res;
      if (res.status === 200 && (res.body.run?.status === "completed" || res.body.run?.status === "failed")) {
        return res;
      }
      // Yield to let the fire-and-forget loop's awaited DB writes progress.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return last!;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc209-deliberation-async-route-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentId = randomUUID();
    for (const id of [companyId, otherCompanyId]) {
      await db.insert(companies).values({
        id,
        name: "Workcell",
        issuePrefix: ("WC" + id.replace(/-/g, "").slice(0, 6)).toUpperCase(),
        requireBoardApprovalForNewAgents: false,
      });
    }
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, activity_log, agent_config_revisions restart identity cascade" as never,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("POST returns 202 + runId; the run persists turns IN ORDER and completes (A propose → B revise → A accept)", async () => {
    await insertAgent(agentId, companyId, enabledDeliberation);
    const stub = makeConsensusStub();
    const app = await makeApp(stub.invoke);

    const res = await request(app)
      .post(`/api/agents/${agentId}/deliberate`)
      .send({ task: "Design the thing." });

    // Async contract: 202 with a runId + running status (NOT the transcript).
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.status).toBe("running");
    expect(typeof res.body.runId).toBe("string");
    const runId = res.body.runId as string;

    // Poll until the fire-and-forget loop finalizes the run.
    const done = await pollRunUntilTerminal(app, agentId, runId);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.run.status).toBe("completed");
    expect(done.body.run.acceptedBy).toBe("A");
    expect(done.body.run.rounds).toBe(2);
    expect(done.body.run.finalOutput).toBe("Revised proposal from Brain B.");
    expect(done.body.run.completedAt).toBeTruthy();

    // Turns persisted in order: propose (A) → revise (B) → accept (A).
    expect(done.body.turns).toHaveLength(3);
    expect(done.body.turns[0]).toMatchObject({ round: 0, brain: "A", action: "propose" });
    expect(done.body.turns[1]).toMatchObject({
      round: 1,
      brain: "B",
      action: "revise",
      feedback: "Tightened the wording.",
    });
    expect(done.body.turns[2]).toMatchObject({ round: 2, brain: "A", action: "accept" });
    // 1 propose + 2 reviews = 3 brain turns drove the stub.
    expect(stub.state.calls).toBe(3);

    // Activity event recorded the run START (runId + running status).
    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.deliberation_run"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(agentId);
    expect(rows[0]!.details).toMatchObject({ runId, status: "running" });
  });

  it("persists 0-cost turns + total for a stub invoke that reports no cost", async () => {
    // The route's stub override is a RAW invoke that ignores the service's
    // onCost, so the run + every turn carry 0 cents. Per-turn cost SUMMATION
    // (where the invoke reports cents through onCost) is covered end-to-end in
    // agent-deliberation-run-service.test.ts via the buildInvoke(onCost) seam.
    await insertAgent(agentId, companyId, enabledDeliberation);
    const stub = makeConsensusStub();
    const app = await makeApp(stub.invoke);

    const res = await request(app)
      .post(`/api/agents/${agentId}/deliberate`)
      .send({ task: "Cost." });
    const runId = res.body.runId as string;
    const done = await pollRunUntilTerminal(app, agentId, runId);

    expect(done.body.run.totalCostCents).toBe(0);
    for (const turn of done.body.turns) {
      expect(turn.costCents).toBe(0);
    }
  });

  it("honors maxRoundsOverride (run completes with acceptedBy null at the override)", async () => {
    await insertAgent(agentId, companyId, enabledDeliberation);
    // Stub that NEVER accepts → loop runs until maxRounds.
    const invoke: DeliberationInvoke = async ({ role }) =>
      role === "propose"
        ? "Initial draft."
        : JSON.stringify({ verdict: "revise", revision: "Another revision.", feedback: "more" });
    const app = await makeApp(invoke);

    const res = await request(app)
      .post(`/api/agents/${agentId}/deliberate`)
      .send({ task: "Iterate.", maxRoundsOverride: 1 });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const runId = res.body.runId as string;
    const done = await pollRunUntilTerminal(app, agentId, runId);

    expect(done.body.run.status).toBe("completed");
    expect(done.body.run.acceptedBy).toBeNull();
    expect(done.body.run.rounds).toBe(1);
    // propose + 1 review = 2 turns persisted.
    expect(done.body.turns).toHaveLength(2);
  });

  it("marks the run 'failed' (with error) when the engine's invoke throws", async () => {
    await insertAgent(agentId, companyId, enabledDeliberation);
    // Invoke throws on the very first (propose) turn → runLoop catches and
    // records status "failed".
    const invoke: DeliberationInvoke = async () => {
      throw new Error("boom: adapter exploded");
    };
    const app = await makeApp(invoke);

    const res = await request(app)
      .post(`/api/agents/${agentId}/deliberate`)
      .send({ task: "Fail me." });

    // The POST still returns 202 — the failure happens in the background loop.
    expect(res.status).toBe(202);
    const runId = res.body.runId as string;
    const done = await pollRunUntilTerminal(app, agentId, runId);

    expect(done.body.run.status).toBe("failed");
    expect(done.body.run.error).toContain("boom: adapter exploded");
    expect(done.body.run.completedAt).toBeTruthy();
    // No turns were produced (it threw on the first turn).
    expect(done.body.turns).toHaveLength(0);
  });

  it("GET /deliberations lists recent runs for the agent (company-scoped)", async () => {
    await insertAgent(agentId, companyId, enabledDeliberation);
    const stub = makeConsensusStub();
    const app = await makeApp(stub.invoke);

    // Kick two runs.
    const r1 = await request(app).post(`/api/agents/${agentId}/deliberate`).send({ task: "One." });
    await pollRunUntilTerminal(app, agentId, r1.body.runId as string);
    const r2 = await request(app).post(`/api/agents/${agentId}/deliberate`).send({ task: "Two." });
    await pollRunUntilTerminal(app, agentId, r2.body.runId as string);

    const list = await request(app).get(`/api/agents/${agentId}/deliberations`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.runs)).toBe(true);
    expect(list.body.runs.length).toBe(2);
    // Newest first.
    expect(list.body.runs[0].task).toBe("Two.");
    expect(list.body.runs[1].task).toBe("One.");
  });

  it("returns 400 when the agent does not have deliberation enabled", async () => {
    await insertAgent(agentId, companyId, undefined);
    const stub = makeConsensusStub();
    const app = await makeApp(stub.invoke);

    const res = await request(app)
      .post(`/api/agents/${agentId}/deliberate`)
      .send({ task: "Design the thing." });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("deliberation not enabled for this agent");
    expect(stub.state.calls).toBe(0);
  });

  it("rejects a cross-company agent (caller scoped to a different company)", async () => {
    // Agent lives in otherCompanyId; the actor is a NON-admin, NON-local board
    // user scoped to companyId only, so assertCompanyAccess rejects the agent's
    // company before any deliberation runs.
    await insertAgent(agentId, otherCompanyId, enabledDeliberation);
    const stub = makeConsensusStub();
    const app = await makeApp(stub.invoke, {
      type: "board",
      userId: "scoped-user",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
      memberships: [{ companyId, membershipRole: "member", status: "active" }],
    });

    const res = await request(app)
      .post(`/api/agents/${agentId}/deliberate`)
      .send({ task: "Design the thing." });

    expect([403, 404]).toContain(res.status);
    expect(stub.state.calls).toBe(0);
  });

  it("returns 404 when the agent does not exist", async () => {
    const stub = makeConsensusStub();
    const app = await makeApp(stub.invoke);

    const res = await request(app)
      .post(`/api/agents/${randomUUID()}/deliberate`)
      .send({ task: "Design the thing." });

    expect(res.status).toBe(404);
    expect(stub.state.calls).toBe(0);
  });

  it("GET /deliberations/:runId 404s for a run that belongs to another company", async () => {
    // A run in otherCompanyId must not be readable via an agent the caller can
    // see in companyId. Insert a run row directly under otherCompanyId.
    await insertAgent(agentId, companyId, enabledDeliberation);
    const otherAgentId = randomUUID();
    await insertAgent(otherAgentId, otherCompanyId, enabledDeliberation);
    const [otherRun] = await db
      .insert(agentDeliberationRuns)
      .values({
        companyId: otherCompanyId,
        agentId: otherAgentId,
        task: "secret",
        status: "completed",
      })
      .returning({ id: agentDeliberationRuns.id });
    await db.insert(agentDeliberationTurns).values({
      runId: otherRun!.id,
      round: 0,
      brain: "A",
      action: "propose",
      content: "secret content",
    });

    const app = await makeApp();
    // Ask for the other-company run id under OUR agent → 404 (run not found for
    // this company / agent).
    const res = await request(app).get(`/api/agents/${agentId}/deliberations/${otherRun!.id}`);
    expect(res.status).toBe(404);
  });

  it("returns 503 deliberation_live_disabled when no stub is injected and the live flag is off", async () => {
    await insertAgent(agentId, companyId, enabledDeliberation);
    const prev = process.env.WORKCELL_PAIR_LIVE_LLM;
    delete process.env.WORKCELL_PAIR_LIVE_LLM;
    try {
      // No invoke override → falls through to the live gate, which is off.
      const app = await makeApp();
      const res = await request(app)
        .post(`/api/agents/${agentId}/deliberate`)
        .send({ task: "Design the thing." });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("deliberation_live_disabled");
    } finally {
      if (prev === undefined) delete process.env.WORKCELL_PAIR_LIVE_LLM;
      else process.env.WORKCELL_PAIR_LIVE_LLM = prev;
    }
  });
});
