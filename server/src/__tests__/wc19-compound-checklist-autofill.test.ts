import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueDocuments,
  issueWorkProducts,
  issues,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-19 compound-checklist autofill embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-19 compound-checklist auto-fill route (D19 second cycle)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let plannerAgentId: string;

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
    // issueRoutes(db, storage) — the heartbeat service is constructed inside,
    // so we observe wakeup via its side-effect (a heartbeat_runs row) rather
    // than a mock.
    server.use("/api", issueRoutes(db, {} as any));
    server.use(errorHandler);
    return server;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc19-checklist-autofill-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
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
    // Seed a planner-role agent so the resolver finds it.
    plannerAgentId = randomUUID();
    await db.insert(agents).values({
      id: plannerAgentId,
      companyId,
      name: "Planner",
      role: "planner",
      status: "idle",
      adapter: "claude_local",
    });
    app = await createApp();
  });

  afterEach(async () => {
    // Wait a tick so background heartbeat work (queueIssueAssignmentWakeup
    // fires fire-and-forget after the response) has a chance to land its
    // writes before the truncate — otherwise the background insert holds
    // locks against the truncate cascade and deadlocks.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Truncate with CASCADE — the FK web among issues/heartbeat_runs/agents
    // (issues.execution_run_id ↔ heartbeat_runs.agent_id) deadlocks when
    // deleted in pieces; TRUNCATE CASCADE collapses it in one shot.
    await db.execute(
      "truncate table companies, agents, issues, heartbeat_runs, documents, issue_documents, issue_work_products, activity_log, agent_runtime_state, company_skills restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedDoneIssueWithChecklist(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Completed work",
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "proof",
      provider: "workcell",
      title: "Proof",
      status: "active",
    });
    // Mark done so WC-12 auto-creates the checklist.
    await svc.update(issueId, { status: "done" });
    return issueId;
  }

  it("spawns a planning child assigned to a planner agent with the autofill origin", async () => {
    const parentId = await seedDoneIssueWithChecklist();

    const res = await request(app)
      .post(`/api/issues/${parentId}/compound-checklist/auto-fill`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.reused).toBe(false);
    expect(res.body.issue).toBeTruthy();
    expect(res.body.issue.assigneeAgentId).toBe(plannerAgentId);
    expect(res.body.issue.workMode).toBe("planning");
    expect(res.body.issue.parentId).toBe(parentId);
    expect(res.body.issue.originKind).toBe("compound_checklist_autofill");
    // Verify the child wasn't auto-defaulted to backlog (which would skip wakeup).
    expect(res.body.issue.status).not.toBe("backlog");
    // The instruction must mention preserving section 5.
    expect(String(res.body.issue.description ?? "")).toContain("Section 5 is HUMAN-DRIVEN");
    expect(String(res.body.issue.description ?? "")).toContain("PUT /issues/" + parentId);

    // The wakeup is fire-and-forget; give it a tick to insert the heartbeat run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const runs = await db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns);
    const plannerRuns = runs.filter((r) => r.agentId === plannerAgentId);
    expect(plannerRuns.length).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent against an in-flight autofill child (returns the existing one with reused=true)", async () => {
    const parentId = await seedDoneIssueWithChecklist();

    const first = await request(app)
      .post(`/api/issues/${parentId}/compound-checklist/auto-fill`)
      .send({});
    expect(first.status).toBe(201);
    const firstChildId = first.body.issue.id;

    const second = await request(app)
      .post(`/api/issues/${parentId}/compound-checklist/auto-fill`)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.issue.id).toBe(firstChildId);

    const children = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.parentId, parentId), eq(issues.originKind, "compound_checklist_autofill")));
    expect(children).toHaveLength(1);
  });

  it("allows a fresh autofill once the prior child reaches done (not reused)", async () => {
    const parentId = await seedDoneIssueWithChecklist();

    const first = await request(app)
      .post(`/api/issues/${parentId}/compound-checklist/auto-fill`)
      .send({});
    expect(first.status).toBe(201);
    const firstChildId = first.body.issue.id;

    // Mark the autofill child done — simulating the agent finishing.
    // Planning issues are exempt from proof-gate so we can update directly.
    await svc.update(firstChildId, { status: "done" });

    const second = await request(app)
      .post(`/api/issues/${parentId}/compound-checklist/auto-fill`)
      .send({});
    expect(second.status).toBe(201);
    expect(second.body.reused).toBe(false);
    expect(second.body.issue.id).not.toBe(firstChildId);
  });

  it("returns 409 when no planner-capable agent exists", async () => {
    const parentId = await seedDoneIssueWithChecklist();
    // Remove the planner agent.
    await db.delete(agents).where(eq(agents.id, plannerAgentId));

    const res = await request(app)
      .post(`/api/issues/${parentId}/compound-checklist/auto-fill`)
      .send({});
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain("planner-capable");
  });

  it("returns 404 when the issue has no compound-checklist yet", async () => {
    // Issue not done → no checklist.
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Not done",
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });

    const res = await request(app)
      .post(`/api/issues/${issueId}/compound-checklist/auto-fill`)
      .send({});
    expect(res.status).toBe(404);
  });

  // ---------- WC-21: auto-trigger on Done transition ----------
  // The PATCH route's done-transition hook calls the same helper as the
  // explicit POST route. These cases verify the integration: a normal
  // mark-done action implicitly fires the autofill workflow without the
  // user clicking a separate button.

  async function seedTodoIssueWithProof(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Execution work",
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "proof",
      provider: "workcell",
      title: "Proof",
      status: "active",
    });
    return issueId;
  }

  it("WC-21: PATCH status=done auto-spawns the autofill child", async () => {
    const parentId = await seedTodoIssueWithProof();

    const res = await request(app)
      .patch(`/api/issues/${parentId}`)
      .send({ status: "done" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");

    const children = await db
      .select({ id: issues.id, status: issues.status, originKind: issues.originKind, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(eq(issues.parentId, parentId), eq(issues.originKind, "compound_checklist_autofill")));
    expect(children).toHaveLength(1);
    expect(children[0].assigneeAgentId).toBe(plannerAgentId);
    expect(children[0].status).not.toBe("backlog");
  });

  it("WC-21: PATCH status=done is silent (still 200) when no planner-capable agent exists", async () => {
    const parentId = await seedTodoIssueWithProof();
    await db.delete(agents).where(eq(agents.id, plannerAgentId));

    const res = await request(app)
      .patch(`/api/issues/${parentId}`)
      .send({ status: "done" });
    // The done click MUST succeed even when no planner is configured.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");

    const children = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.parentId, parentId), eq(issues.originKind, "compound_checklist_autofill")));
    expect(children).toHaveLength(0);
  });

  it("WC-21: PATCH status=done does NOT auto-spawn for planning-mode issues (no checklist exists)", async () => {
    const planningId = randomUUID();
    await db.insert(issues).values({
      id: planningId,
      companyId,
      title: "Plan",
      status: "todo",
      priority: "medium",
      workMode: "planning",
    });

    const res = await request(app)
      .patch(`/api/issues/${planningId}`)
      .send({ status: "done" });
    expect(res.status).toBe(200);

    const children = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.parentId, planningId), eq(issues.originKind, "compound_checklist_autofill")));
    expect(children).toHaveLength(0);
  });
});
