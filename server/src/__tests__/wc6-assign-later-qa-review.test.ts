import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@workcell/db";
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
    summary: "WC-6 assign-later-qa test run.",
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
    `Skipping WC-6 assign-later embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regenerated per test (beforeEach) so the shared embedded-Postgres DB stays
// collision-free and order-independent.
let companyId: string;
let engineerAgentId: string;
let qaAgentId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-6 default QA policy on assignment (completes WC-5)", () => {
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
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc6-assign-later-qa-");
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
    runningProcesses.clear();
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
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
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      permissions: {},
    });
  }

  // Seed a bare execution-mode issue (no assignee, no policy) directly via the DB so
  // we can then exercise the assignment PATCH path that WC-6 hooks into.
  async function seedBareExecutionIssue(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue created unassigned",
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });
    return issueId;
  }

  async function seedBareIssueWithExplicitPolicy(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with explicit policy",
      status: "todo",
      priority: "medium",
      workMode: "standard",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: randomUUID(),
            type: "approval",
            approvalsNeeded: 1,
            participants: [
              { id: randomUUID(), type: "agent", agentId: engineerAgentId, userId: null },
            ],
          },
        ],
        monitor: null,
      },
    });
    return issueId;
  }

  async function seedBarePlanningIssue(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Planning issue",
      status: "todo",
      priority: "medium",
      workMode: "planning",
    });
    return issueId;
  }

  async function patchAssignee(issueId: string, body: Record<string, unknown>) {
    return request(app).patch(`/api/issues/${issueId}`).send(body);
  }

  it("injects a default QA review stage when an unassigned execution issue is later assigned to an agent", async () => {
    await seedCompany();
    await seedAgent(engineerAgentId, "engineer");
    await seedAgent(qaAgentId, "qa");
    const issueId = await seedBareExecutionIssue();

    const res = await patchAssignee(issueId, { assigneeAgentId: engineerAgentId });
    expect(res.status).toBe(200);

    // Response reflects the injected policy (Mirror WC-5: single review stage with the QA agent).
    expect(res.body.executionPolicy).toBeTruthy();
    expect(res.body.executionPolicy.stages).toHaveLength(1);
    expect(res.body.executionPolicy.stages[0].type).toBe("review");
    expect(res.body.executionPolicy.stages[0].participants[0]).toMatchObject({
      type: "agent",
      agentId: qaAgentId,
    });

    // And persisted to the row.
    const row = await db
      .select({ executionPolicy: issues.executionPolicy })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionPolicy).toBeTruthy();
    expect((row?.executionPolicy as { stages?: unknown[] })?.stages).toHaveLength(1);
  });

  it("preserves an existing explicit policy when the issue is later assigned", async () => {
    await seedCompany();
    await seedAgent(engineerAgentId, "engineer");
    await seedAgent(qaAgentId, "qa");
    const issueId = await seedBareIssueWithExplicitPolicy();

    const res = await patchAssignee(issueId, { assigneeAgentId: engineerAgentId });
    expect(res.status).toBe(200);

    // Explicit approval stage on the seeded issue survives — QA default did not override.
    expect(res.body.executionPolicy.stages).toHaveLength(1);
    expect(res.body.executionPolicy.stages[0].type).toBe("approval");
  });

  it("does not inject a policy for planning issues", async () => {
    await seedCompany();
    await seedAgent(engineerAgentId, "engineer");
    await seedAgent(qaAgentId, "qa");
    const issueId = await seedBarePlanningIssue();

    const res = await patchAssignee(issueId, { assigneeAgentId: engineerAgentId });
    expect(res.status).toBe(200);
    expect(res.body.executionPolicy ?? null).toBeNull();
  });

  it("does not inject a policy when the company has no QA agent", async () => {
    await seedCompany();
    await seedAgent(engineerAgentId, "engineer");
    const issueId = await seedBareExecutionIssue();

    const res = await patchAssignee(issueId, { assigneeAgentId: engineerAgentId });
    expect(res.status).toBe(200);
    expect(res.body.executionPolicy ?? null).toBeNull();
  });

  it("does not route review to the new assignee itself (only QA agent is the assignee)", async () => {
    await seedCompany();
    // The only QA agent is also the agent being assigned → no eligible reviewer ≠ self.
    await seedAgent(qaAgentId, "qa");
    const issueId = await seedBareExecutionIssue();

    const res = await patchAssignee(issueId, { assigneeAgentId: qaAgentId });
    expect(res.status).toBe(200);
    expect(res.body.executionPolicy ?? null).toBeNull();
  });

  it("does not inject a policy when the PATCH does not change the agent assignee", async () => {
    await seedCompany();
    await seedAgent(engineerAgentId, "engineer");
    await seedAgent(qaAgentId, "qa");
    const issueId = await seedBareExecutionIssue();

    // PATCHing a non-assignment field (priority here) must not trigger the WC-6 default
    // — the unassigned issue stays unassigned and policy-less. WC-6 only fires on a
    // real agent-assignment change.
    const res = await patchAssignee(issueId, { priority: "high" });
    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId ?? null).toBeNull();
    expect(res.body.executionPolicy ?? null).toBeNull();
  });
});
