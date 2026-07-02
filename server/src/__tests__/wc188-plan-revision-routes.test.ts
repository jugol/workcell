import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

// WC-188 / CP7: user feedback on a PLAN revises the plan/기획 — the PLAN-side
// mirror of the design request-changes→designer loop. Exercises the route
// (POST /issues/:id/plan/request-revision) against the real issueRoutes over
// embedded Postgres, mirroring the WC-2 draft-from-prompt harness (a canned
// adapter so the planner wakeup can queue/run a heartbeat run without a real
// LLM) plus the design-review-routes board/agent actor injection.

// Canned adapter so the planner wakeup can queue/run without invoking a real LLM.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "WC-188 plan revision test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-188 plan-revision route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("WC-188 plan-revision route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc188-plan-revision-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(() => {
    // Per-test unique ids isolate data (mirrors the WC-2 draft harness); a
    // cross-test TRUNCATE would race the planner wakeup's async writes to
    // agent_wakeup_requests / heartbeat_run_events and trip FK constraints.
    runningProcesses.clear();
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createApp(actor: Express.Request["actor"]) {
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    // Minimal storage stub: the plan-revision route never touches storage.
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: null,
      source: "agent_jwt",
    };
  }

  // Seeds a company + a planner-capable agent (heartbeat enabled so the wakeup
  // can run) + an issue assigned to a DIFFERENT non-planner agent — proving the
  // route wakes the planner regardless of the issue's current assignee.
  async function seed() {
    const companyId = randomUUID();
    const plannerId = randomUUID();
    const executorId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();

    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: plannerId,
        companyId,
        name: "Planner",
        // "pm" is the planner-capable role used by the draft/autofill paths.
        role: "pm",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 },
        },
        permissions: {},
      },
      {
        id: executorId,
        companyId,
        name: "Executor",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Plan the CSV export",
      status: "todo",
      priority: "medium",
      workMode: "planning",
      assigneeAgentId: executorId,
    });

    return { companyId, plannerId, executorId, issueId };
  }

  it("records the feedback (comment + activity) and wakes the planner with the reason", async () => {
    const { companyId, plannerId, issueId } = await seed();
    const feedback = "The acceptance criteria miss the empty-state case — add it to the plan.";

    const res = await request(await createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/plan/request-revision`)
      .send({ feedback });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({ ok: true, plannerAgentId: plannerId }),
    );

    // The feedback is recorded as a board comment carrying the reason text.
    const comment = await db
      .select({ body: issueComments.body, authorUserId: issueComments.authorUserId })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows[0] ?? null);
    expect(comment).not.toBeNull();
    expect(comment!.body).toBe(feedback);
    expect(comment!.authorUserId).toBe("board-user");

    // The plan_revision_requested activity is logged with the planner id
    // (scoped to this issue's entityId so accumulated cross-test rows can't leak).
    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "issue.plan_revision_requested"),
          eq(activityLog.entityId, issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(audit).not.toBeNull();
    expect(audit!.details).toMatchObject({ plannerAgentId: plannerId });

    // The wakeup fires the PLANNER's run (not the executor's), proving we reuse
    // the heartbeat/run machinery and carry the feedback to the planner.
    const wokePlanner = await waitForCondition(async () => {
      const run = await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`)
        .then((rows) => rows[0] ?? null);
      return Boolean(run && run.agentId === plannerId);
    });
    expect(wokePlanner).toBe(true);

    // The wake context carries the plan_revision_requested reason + the feedback.
    const wakeContext = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`)
      .then((rows) => rows[0]?.contextSnapshot as Record<string, unknown> | null);
    expect(wakeContext).toMatchObject({
      wakeReason: "plan_revision_requested",
      feedback,
    });
  });

  it("returns 409 when no planner-capable agent exists", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    // Two non-planner agents: no planner/pm/orchestrator role, and >1 active agent
    // defeats the "exactly one eligible agent" fallback → forces the 409 path.
    await db.insert(agents).values([
      {
        id: randomUUID(),
        companyId,
        name: "Eng A",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: randomUUID(),
        companyId,
        name: "Eng B",
        role: "designer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Plan something",
      status: "todo",
      priority: "medium",
      workMode: "planning",
      assigneeAgentId: null,
    });

    const res = await request(await createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/plan/request-revision`)
      .send({ feedback: "Please revise." });
    expect(res.status).toBe(409);
    expect(String(res.body?.error ?? res.text)).toMatch(/no planner-capable agent/i);
  });

  it("rejects an AGENT actor with 403 (board required)", async () => {
    const { companyId, executorId, issueId } = await seed();

    const res = await request(await createApp(agentActor(companyId, executorId)))
      .post(`/api/issues/${issueId}/plan/request-revision`)
      .send({ feedback: "agents cannot give plan feedback" });

    expect(res.status).toBe(403);
    // No comment is recorded when authz fails.
    const count = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(count.length).toBe(0);
  });

  it("rejects a board actor from another tenant with 403", async () => {
    const { issueId } = await seed();
    const otherCompanyId = randomUUID();

    const res = await request(await createApp(boardActor(otherCompanyId)))
      .post(`/api/issues/${issueId}/plan/request-revision`)
      .send({ feedback: "cross-tenant attempt" });

    expect(res.status).toBe(403);
  });

  it("rejects an empty / whitespace-only feedback with 400", async () => {
    const { companyId, issueId } = await seed();

    const res = await request(await createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/plan/request-revision`)
      .send({ feedback: "   " });

    expect(res.status).toBe(400);
    // Nothing is recorded for an invalid request.
    const count = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(count.length).toBe(0);
  });

  it("returns 404 for a missing issue id", async () => {
    const { companyId } = await seed();

    const res = await request(await createApp(boardActor(companyId)))
      .post(`/api/issues/${randomUUID()}/plan/request-revision`)
      .send({ feedback: "no such issue" });

    expect(res.status).toBe(404);
  });
});
