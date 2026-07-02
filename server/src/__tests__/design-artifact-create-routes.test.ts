import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueWorkProducts,
  issues,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

// WC-182d / D22: in-product creation path for design-type work products
// (POST /issues/:id/design-artifacts). The standard work-product create route
// validates against the NARROW issueWorkProductTypeSchema (which excludes design
// types), so before this slice a design artifact could only be created by the
// external Open Design daemon or a direct DB insert. This exercises the new
// route against the real issueRoutes + workProductService over embedded
// Postgres, injecting board vs agent actors the same way the design-review gate
// route test does (mirrors that harness).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-182d design-artifact create route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("design-artifact create route (WC-182d/D22)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-design-artifact-create-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.execute("truncate table activity_log restart identity cascade" as any);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
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

  const noneActor: Express.Request["actor"] = { type: "none", source: "none" };

  // Seeds a company + agent + issue. The issue is intentionally left unassigned
  // so an agent actor passes the agent-mutation guard (assigneeAgentId === null
  // short-circuits to allowed), letting us exercise the designer (agent) create
  // path without a checkout run.
  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Designer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Design parent",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: null,
    });

    return { companyId, agentId, issueId };
  }

  it("creates a design-type work product with sensible defaults (board)", async () => {
    const { companyId, issueId } = await seed();

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/design-artifacts`)
      .send({ title: "Login screen design" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // type defaults to "design", provider to "workcell".
    expect(res.body.type).toBe("design");
    expect(res.body.provider).toBe("workcell");
    expect(res.body.title).toBe("Login screen design");
    // The route pins the freshly-created lifecycle state.
    expect(res.body.reviewState).toBe("none");
    expect(res.body.status).toBe("active");
    expect(res.body.isPrimary).toBe(false);
    expect(res.body.issueId).toBe(issueId);

    // It is persisted as a real design-type work product on the issue.
    const rows = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("design");

    // And an audit event was logged with the workProductId + type.
    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.design_artifact_created"))
      .then((r) => r[0]);
    expect(audit).toMatchObject({
      action: "issue.design_artifact_created",
      details: { workProductId: res.body.id, type: "design" },
    });
  });

  it("accepts an explicit design subtype (type=mockup)", async () => {
    const { companyId, issueId } = await seed();

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/design-artifacts`)
      .send({ type: "mockup", title: "Checkout mockup", url: "https://example.com/m" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.type).toBe("mockup");
    expect(res.body.url).toBe("https://example.com/m");
    expect(res.body.reviewState).toBe("none");
  });

  it("isPrimary:true makes the created design the authoritative source of truth", async () => {
    const { companyId, issueId } = await seed();

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/design-artifacts`)
      .send({ type: "design", title: "Authoritative design", isPrimary: true });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.isPrimary).toBe(true);

    // Per-type uniqueness: it is the single primary design-type product on the issue.
    const primaries = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.isPrimary, true));
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.id).toBe(res.body.id);
  });

  it("rejects a non-design type in the body via the schema (400)", async () => {
    const { companyId, issueId } = await seed();

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/design-artifacts`)
      .send({ type: "proof", title: "Not a design" });

    // createDesignArtifactSchema constrains `type` to the design-type set;
    // validate() throws a ZodError → 400 from the error handler.
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    // Nothing was written.
    const rows = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId));
    expect(rows).toHaveLength(0);
  });

  it("returns 404 for a missing issue", async () => {
    const { companyId } = await seed();
    const missingId = randomUUID();

    await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${missingId}/design-artifacts`)
      .send({ title: "x" })
      .expect(404);
  });

  it("an agent of the company can create (designer path)", async () => {
    const { companyId, agentId, issueId } = await seed();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/issues/${issueId}/design-artifacts`)
      .send({ type: "ui_preview", title: "Agent-authored preview" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.type).toBe("ui_preview");

    // The audit event attributes the creation to the agent actor.
    const audit = await db
      .select({ agentId: activityLog.agentId, actorType: activityLog.actorType })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.design_artifact_created"))
      .then((r) => r[0]);
    expect(audit).toMatchObject({ agentId, actorType: "agent" });
  });

  it("forbids a cross-company agent actor (403)", async () => {
    const { issueId } = await seed();
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();

    const res = await request(createApp(agentActor(otherCompanyId, otherAgentId)))
      .post(`/api/issues/${issueId}/design-artifacts`)
      .send({ title: "Cross-company attempt" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // Nothing was written.
    const rows = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId));
    expect(rows).toHaveLength(0);
  });

  it("forbids an unauthenticated (none) actor (401)", async () => {
    const { issueId } = await seed();

    const res = await request(createApp(noneActor))
      .post(`/api/issues/${issueId}/design-artifacts`)
      .send({ title: "Anonymous attempt" });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
  });
});
