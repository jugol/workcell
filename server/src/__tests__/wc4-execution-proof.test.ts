import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueWorkProducts, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-4 execution-proof embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regenerated per test (beforeEach) so the shared embedded-Postgres DB stays
// collision-free and order-independent. Each assertion creates its own issue.
let companyId: string;
let agentId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-4 execution produces proof", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Express app whose actor is the assigned agent. The work-products route never
  // touches storage, so a bare stub is sufficient (same as the WC-2 draft route).
  function createAgentApp() {
    const actorCompanyId = companyId;
    const actorAgentId = agentId;
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: actorAgentId,
        companyId: actorCompanyId,
        runId: null,
      };
      next();
    });
    server.use("/api", issueRoutes(db, {} as any));
    server.use(errorHandler);
    return server;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc4-execution-proof-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    // issue_prefix is UNIQUE across companies — derive a per-test value.
    issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      permissions: {},
    });
  });

  // No afterEach cleanup: every company/agent/issue id is regenerated per test, so
  // rows never collide and tests stay order-independent. (The work-products route
  // also writes activity_log rows that reference the agent, which makes a blanket
  // DELETE order-sensitive — unique ids avoid the problem entirely.)

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAssignedIssue(status: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Execution issue",
      status,
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  it("lets the executing agent attach a proof bundle via the work-products route, unblocking Done", async () => {
    const issueId = await seedAssignedIssue("todo");

    // Negative control: Done is blocked before any proof exists (WC-3 gate).
    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
      message: "done requires a proof bundle",
    });

    // The assigned agent attaches a proof bundle through the real authorized route.
    // Assignee + non-in_progress status passes mutation auth without a checkout lock,
    // so this exercises the same path an executing agent uses to leave proof.
    const app = createAgentApp();
    const res = await request(app)
      .post(`/api/issues/${issueId}/work-products`)
      .send({
        type: "proof",
        provider: "workcell",
        title: "Execution proof",
        status: "active",
        summary: "typecheck + vitest green",
      });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("proof");

    // The proof row is persisted for the issue.
    const proofRow = await db
      .select({ id: issueWorkProducts.id, type: issueWorkProducts.type })
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.issueId, issueId), eq(issueWorkProducts.type, "proof")))
      .then((rows) => rows[0] ?? null);
    expect(proofRow).not.toBeNull();
    expect(proofRow!.type).toBe("proof");

    // With the proof bundle in place, the gate passes and Done is stamped.
    const updated = await svc.update(issueId, { status: "done" });
    expect(updated?.status).toBe("done");
    expect(updated?.completedAt).toBeInstanceOf(Date);
  });

  it("does not let a non-proof work product attached via the route unblock Done", async () => {
    const issueId = await seedAssignedIssue("todo");

    // The agent attaches a non-proof artifact through the same route.
    const app = createAgentApp();
    const res = await request(app)
      .post(`/api/issues/${issueId}/work-products`)
      .send({
        type: "document",
        provider: "workcell",
        title: "Design note",
        status: "active",
      });
    expect(res.status).toBe(201);

    // The gate is proof-type-specific: a non-proof artifact must not satisfy it.
    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
      message: "done requires a proof bundle",
    });
  });
});
