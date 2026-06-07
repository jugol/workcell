import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, projects } from "@workcell/db";
import { executionWorkspaces } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { parallelDispatchService } from "../services/parallel-dispatch.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-42 parallel dispatch embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-42 parallel-dispatch candidate identification (PLAN §9 #5)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof parallelDispatchService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let agentA: string;
  let agentB: string;
  let agentBusy: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc42-parallel-dispatch-");
    db = createDb(tempDb.connectionString);
    svc = parallelDispatchService(db);
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
    agentA = randomUUID();
    agentB = randomUUID();
    agentBusy = randomUUID();
    await db.insert(agents).values([
      { id: agentA, companyId, name: "Ada", role: "engineer", status: "idle", adapterType: "claude_local" },
      { id: agentB, companyId, name: "Ben", role: "engineer", status: "idle", adapterType: "claude_local" },
      { id: agentBusy, companyId, name: "Burst", role: "engineer", status: "busy", adapterType: "claude_local" },
    ]);
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, projects, issues, execution_workspaces, heartbeat_runs restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(input: {
    status?: string;
    assigneeAgentId?: string | null;
    executionWorkspaceId?: string | null;
    executionRunId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: `Issue ${id.slice(0, 6)}`,
      status: input.status ?? "todo",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: input.assigneeAgentId ?? null,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      executionRunId: input.executionRunId ?? null,
    });
    return id;
  }

  it("returns candidates only for todo/backlog issues with idle agents and no in-flight run", async () => {
    await seedIssue({ status: "todo", assigneeAgentId: agentA });
    await seedIssue({ status: "backlog", assigneeAgentId: agentB });
    // Excluded: in_progress.
    await seedIssue({ status: "in_progress", assigneeAgentId: agentA });
    // Excluded: no assignee.
    await seedIssue({ status: "todo", assigneeAgentId: null });
    // Excluded: busy agent.
    await seedIssue({ status: "todo", assigneeAgentId: agentBusy });
    // Excluded: in-flight run. Need to seed a real heartbeat_runs row
    // first (executionRunId is FK-enforced).
    const runRowId = randomUUID();
    // Use a TERMINAL run here so this case isolates the per-issue
    // executionRunId filter — a non-terminal run would (correctly, per WC-55)
    // also exclude the whole agent, which a separate test covers.
    await db.insert(heartbeatRuns).values({
      id: runRowId,
      companyId,
      agentId: agentA,
      invocationSource: "on_demand",
      status: "completed",
    });
    await seedIssue({ status: "todo", assigneeAgentId: agentA, executionRunId: runRowId });

    const plan = await svc.candidatesForCompany(companyId);
    expect(plan.candidates).toHaveLength(2);
    const names = plan.candidates.map((c) => c.agentName).sort();
    expect(names).toEqual(["Ada", "Ben"]);
  });

  it("dedupes dispatchable by executionWorkspaceId; null workspaces don't dedupe", async () => {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "P",
    });
    const ws1 = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: ws1,
      companyId,
      projectId,
      mode: "shared",
      strategyType: "local",
      name: "Workspace 1",
    });
    // Two DIFFERENT agents share ws1 (workspace collision), and each also has
    // a null-workspace issue.
    await seedIssue({ status: "todo", assigneeAgentId: agentA, executionWorkspaceId: ws1 });
    await seedIssue({ status: "todo", assigneeAgentId: agentB, executionWorkspaceId: ws1 });
    await seedIssue({ status: "todo", assigneeAgentId: agentA, executionWorkspaceId: null });
    await seedIssue({ status: "todo", assigneeAgentId: agentB, executionWorkspaceId: null });

    const plan = await svc.candidatesForCompany(companyId);
    expect(plan.candidates).toHaveLength(4); // all 4 pass the agent filter
    // WC-55: dispatchable is deduped per workspace AND per agent. With 2
    // distinct agents, at most 2 dispatch — one per agent.
    expect(plan.dispatchable).toHaveLength(2);
    const agentsDispatched = new Set(plan.dispatchable.map((c) => c.assigneeAgentId));
    expect(agentsDispatched.size).toBe(2); // each agent appears exactly once
  });

  it("WC-55: excludes an agent that has a queued (unclaimed) heartbeat run", async () => {
    // agentA is idle but already has a QUEUED run (not yet claimed → still
    // idle, issue.executionRunId still null). It must NOT be re-dispatched.
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId: agentA,
      invocationSource: "automation",
      status: "queued",
    });
    await seedIssue({ status: "todo", assigneeAgentId: agentA });
    await seedIssue({ status: "todo", assigneeAgentId: agentB });

    const plan = await svc.candidatesForCompany(companyId);
    // Only agentB is dispatchable; agentA is busy with the queued run.
    expect(plan.candidates.map((c) => c.agentName)).toEqual(["Ben"]);
    expect(plan.dispatchable).toHaveLength(1);
  });

  it("WC-55: one agent with two null-workspace issues yields a single dispatchable (per-agent cap)", async () => {
    await seedIssue({ status: "todo", assigneeAgentId: agentA });
    await seedIssue({ status: "todo", assigneeAgentId: agentA });

    const plan = await svc.candidatesForCompany(companyId);
    expect(plan.candidates).toHaveLength(2); // both are candidates
    expect(plan.dispatchable).toHaveLength(1); // but only one wakeup for the agent
  });

  it("returns empty arrays when no queued issues exist", async () => {
    const plan = await svc.candidatesForCompany(companyId);
    expect(plan.candidates).toEqual([]);
    expect(plan.dispatchable).toEqual([]);
  });

  // ---------- WC-44: route + dispatcher ----------

  it("WC-44: POST .../wake fires wakeups for each dispatchable candidate and reports per-issue ok", async () => {
    // We need to import the route + an express app to drive it
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const { vi } = await import("vitest");
    await seedIssue({ status: "todo", assigneeAgentId: agentA });
    await seedIssue({ status: "todo", assigneeAgentId: agentB });

    const [{ parallelDispatchRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/parallel-dispatch.js")>(
        "../routes/parallel-dispatch.js",
      ),
      vi.importActual<typeof import("../middleware/index.js")>(
        "../middleware/index.js",
      ),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", parallelDispatchRoutes(db));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${companyId}/parallel-dispatch-candidates/wake`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.dispatched).toHaveLength(2);
    // Each dispatched entry has ok or error.
    for (const entry of res.body.dispatched) {
      expect(typeof entry.ok).toBe("boolean");
      expect(typeof entry.issueId).toBe("string");
      expect(typeof entry.agentId).toBe("string");
    }
  });

  it("WC-44: POST .../wake respects maxToDispatch", async () => {
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const { vi } = await import("vitest");
    await seedIssue({ status: "todo", assigneeAgentId: agentA });
    await seedIssue({ status: "todo", assigneeAgentId: agentB });

    const [{ parallelDispatchRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/parallel-dispatch.js")>(
        "../routes/parallel-dispatch.js",
      ),
      vi.importActual<typeof import("../middleware/index.js")>(
        "../middleware/index.js",
      ),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", parallelDispatchRoutes(db));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${companyId}/parallel-dispatch-candidates/wake`)
      .send({ maxToDispatch: 1 });
    expect(res.status).toBe(200);
    expect(res.body.dispatched).toHaveLength(1);
    expect(res.body.skipped).toBe(1);
  });
});
