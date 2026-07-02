import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

// Canned adapter so any assignment wakeup can no-op without invoking a real LLM.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "WC-5 default-qa-review test run.",
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
    `Skipping WC-5 default-qa-review embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regenerated per test (beforeEach) so the shared embedded-Postgres DB stays
// collision-free and order-independent.
let companyId: string;
let engineerAgentId: string;
let qaAgentId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-5 default QA-review signoff policy", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;

  async function createApp() {
    const actorCompanyId = companyId;
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [actorCompanyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    server.use("/api", issueRoutes(db, {} as any));
    server.use(errorHandler);
    return server;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc5-default-qa-review-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    engineerAgentId = randomUUID();
    qaAgentId = randomUUID();
    issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();
    app = await createApp();
  });

  afterEach(() => {
    // Per-test unique ids isolate data; just stop run tracking and reset the mock.
    runningProcesses.clear();
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(overrides: Partial<typeof companies.$inferInsert> = {}) {
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      ...overrides,
    });
  }

  async function seedAgent(id: string, role: string) {
    await db.insert(agents).values({
      id,
      companyId,
      name: role,
      role,
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      // Heartbeat disabled: we only assert the create response, no runs should fire.
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      permissions: {},
    });
  }

  async function createIssue(body: Record<string, unknown>) {
    return request(app).post(`/api/companies/${companyId}/issues`).send(body);
  }

  it("defaults a QA review stage for an execution issue when an eligible QA agent exists", async () => {
    await seedCompany();
    await seedAgent(engineerAgentId, "engineer");
    await seedAgent(qaAgentId, "qa");

    const res = await createIssue({
      title: "Ship the export button",
      status: "todo",
      priority: "medium",
      assigneeAgentId: engineerAgentId,
    });

    expect(res.status).toBe(201);
    expect(res.body.executionPolicy).toBeTruthy();
    expect(res.body.executionPolicy.stages).toHaveLength(1);
    expect(res.body.executionPolicy.stages[0].type).toBe("review");
    const participants = res.body.executionPolicy.stages[0].participants;
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({ type: "agent", agentId: qaAgentId });
  });

  it("does not default a policy for a planning issue", async () => {
    await seedCompany();
    await seedAgent(engineerAgentId, "engineer");
    await seedAgent(qaAgentId, "qa");

    const res = await createIssue({
      title: "Plan the export feature",
      status: "todo",
      priority: "medium",
      workMode: "planning",
      assigneeAgentId: engineerAgentId,
    });

    expect(res.status).toBe(201);
    expect(res.body.workMode).toBe("planning");
    expect(res.body.executionPolicy ?? null).toBeNull();
  });

  it("does not default a policy when the company has no QA agent", async () => {
    await seedCompany();
    await seedAgent(engineerAgentId, "engineer");

    const res = await createIssue({
      title: "Ship without QA staff",
      status: "todo",
      priority: "medium",
      assigneeAgentId: engineerAgentId,
    });

    expect(res.status).toBe(201);
    expect(res.body.executionPolicy ?? null).toBeNull();
  });

  it("preserves an explicitly provided execution policy (never overrides)", async () => {
    await seedCompany();
    await seedAgent(engineerAgentId, "engineer");
    await seedAgent(qaAgentId, "qa");

    const res = await createIssue({
      title: "Explicit approval policy",
      status: "todo",
      priority: "medium",
      assigneeAgentId: engineerAgentId,
      executionPolicy: {
        stages: [{ type: "approval", participants: [{ type: "agent", agentId: engineerAgentId }] }],
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.executionPolicy.stages).toHaveLength(1);
    // The explicit approval stage survives — the QA default did not replace it.
    expect(res.body.executionPolicy.stages[0].type).toBe("approval");
    expect(res.body.executionPolicy.stages[0].participants[0]).toMatchObject({
      type: "agent",
      agentId: engineerAgentId,
    });
  });

  it("does not route review to the executor itself (QA agent is the assignee)", async () => {
    await seedCompany();
    // The only QA agent is also the assignee → no eligible reviewer other than self.
    await seedAgent(qaAgentId, "qa");

    const res = await createIssue({
      title: "QA agent doing the work",
      status: "todo",
      priority: "medium",
      assigneeAgentId: qaAgentId,
    });

    expect(res.status).toBe(201);
    expect(res.body.executionPolicy ?? null).toBeNull();
  });

  // Workcell philosophy: the board states direction; the Orchestrator routes it.
  // A board-created top-level issue with no explicit assignee is auto-routed to
  // the company's orchestrator (lead fallback) so the wakeup fired on create can
  // immediately start routing.
  describe("default orchestrator auto-routing on board create", () => {
    let orchestratorAgentId: string;
    let leadAgentId: string;

    beforeEach(() => {
      orchestratorAgentId = randomUUID();
      leadAgentId = randomUUID();
    });

    it("assigns a board-created top-level issue to the orchestrator by default", async () => {
      await seedCompany();
      await seedAgent(engineerAgentId, "engineer");
      await seedAgent(orchestratorAgentId, "orchestrator");

      const res = await createIssue({
        title: "Improve onboarding flow",
        status: "todo",
        priority: "medium",
      });

      expect(res.status).toBe(201);
      expect(res.body.assigneeAgentId).toBe(orchestratorAgentId);

      // The create activity log marks the assignment as auto-routed.
      const logs = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, res.body.id));
      const createdLog = logs.find((row) => row.action === "issue.created");
      expect(createdLog).toBeTruthy();
      expect((createdLog?.details as Record<string, unknown>)?.autoRouted).toBe(true);
    });

    it("respects an explicitly provided assignee (never overrides)", async () => {
      await seedCompany();
      await seedAgent(engineerAgentId, "engineer");
      await seedAgent(orchestratorAgentId, "orchestrator");

      const res = await createIssue({
        title: "Explicitly assigned work",
        status: "todo",
        priority: "medium",
        assigneeAgentId: engineerAgentId,
      });

      expect(res.status).toBe(201);
      expect(res.body.assigneeAgentId).toBe(engineerAgentId);
    });

    it("does not inject an assignee for child issues (parentId set)", async () => {
      await seedCompany();
      await seedAgent(orchestratorAgentId, "orchestrator");

      const parentRes = await createIssue({
        title: "Parent issue",
        status: "todo",
        priority: "medium",
      });
      expect(parentRes.status).toBe(201);

      const childRes = await createIssue({
        title: "Child issue",
        status: "todo",
        priority: "medium",
        parentId: parentRes.body.id,
      });

      expect(childRes.status).toBe(201);
      expect(childRes.body.assigneeAgentId ?? null).toBeNull();
    });

    it("falls back to a lead agent when no orchestrator exists", async () => {
      await seedCompany();
      await seedAgent(engineerAgentId, "engineer");
      await seedAgent(leadAgentId, "lead");

      const res = await createIssue({
        title: "Routed to the lead",
        status: "todo",
        priority: "medium",
      });

      expect(res.status).toBe(201);
      expect(res.body.assigneeAgentId).toBe(leadAgentId);
    });

    it("leaves the issue unassigned when neither an orchestrator nor a lead exists", async () => {
      await seedCompany();
      await seedAgent(engineerAgentId, "engineer");

      const res = await createIssue({
        title: "No router available",
        status: "todo",
        priority: "medium",
      });

      expect(res.status).toBe(201);
      expect(res.body.assigneeAgentId ?? null).toBeNull();
    });

    // Team autonomy: company.autoRouteNewIssues (default ON) gates the
    // orchestrator injection — when the board turns it off, a routable issue
    // stays unassigned even though an orchestrator exists.
    it("does not auto-route when company.autoRouteNewIssues is off", async () => {
      await seedCompany({ autoRouteNewIssues: false });
      await seedAgent(engineerAgentId, "engineer");
      await seedAgent(orchestratorAgentId, "orchestrator");

      const res = await createIssue({
        title: "Manual routing requested",
        status: "todo",
        priority: "medium",
      });

      expect(res.status).toBe(201);
      expect(res.body.assigneeAgentId ?? null).toBeNull();

      // No autoRouted marker on the create activity log either.
      const logs = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, res.body.id));
      const createdLog = logs.find((row) => row.action === "issue.created");
      expect(createdLog).toBeTruthy();
      expect((createdLog?.details as Record<string, unknown>)?.autoRouted).toBeUndefined();
    });
  });
});
