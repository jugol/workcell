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

// WC-183a / D22 / D13: in-product "기존 UI 스캔 → 디자인시스템 추출" route
// (POST /issues/:id/design-system). Given captured UI markup it extracts the
// design tokens PURELY and stores them as a design-type work product
// (metadata.kind === "design_system", metadata.tokens populated). This exercises
// the new route against the real issueRoutes + workProductService over embedded
// Postgres, mirroring the design-artifact create route harness.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-183a design-system route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const SAMPLE_HTML = `<!doctype html><html><head><style>
  body { font-family: "Inter", system-ui; color: #1a2b3c; }
  .btn { font-size: 14px; padding: 8px 16px; background: rgb(255,0,0); }
</style></head><body>
  <header style="font-size: 24px; color: #fff;">Hi</header>
  <nav><a href="#">Home</a></nav>
  <button class="btn">Save</button>
  <input type="text" />
</body></html>`;

describeEmbeddedPostgres("design-system extract route (WC-183a/D22/D13)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-design-system-routes-");
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
    app.use(express.json({ limit: "5mb" }));
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

  // Seeds a company + agent + issue. The issue is left unassigned so an agent
  // actor passes the agent-mutation guard (assigneeAgentId === null → allowed).
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
      title: "Existing app to scan",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: null,
    });

    return { companyId, agentId, issueId };
  }

  it("extracts a design system and stores it as a design work product (board)", async () => {
    const { companyId, issueId } = await seed();

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/design-system`)
      .send({ html: SAMPLE_HTML });

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // Response shape: { workProduct, designSystem }.
    const { workProduct, designSystem } = res.body;
    expect(workProduct.type).toBe("design");
    expect(workProduct.provider).toBe("workcell");
    expect(workProduct.title).toBe("Design System (extracted)");
    expect(workProduct.reviewState).toBe("none");
    expect(workProduct.status).toBe("active");
    // A design SYSTEM is reference, not the authoritative screen 시안.
    expect(workProduct.isPrimary).toBe(false);
    expect(workProduct.issueId).toBe(issueId);
    // The preview is a utf-8 data URL.
    expect(typeof workProduct.url).toBe("string");
    expect(workProduct.url.startsWith("data:text/html;charset=utf-8,")).toBe(true);

    // The extracted tokens are echoed and stored under metadata.
    expect(designSystem.colors.length).toBeGreaterThan(0);
    expect(workProduct.metadata.kind).toBe("design_system");
    expect(workProduct.metadata.tokens.colors).toEqual(designSystem.colors);
    expect(workProduct.metadata.tokens.fontFamilies).toContain("Inter");

    // Persisted as a real design-type work product carrying the tokens.
    const rows = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("design");
    expect(rows[0]?.isPrimary).toBe(false);
    const metadata = rows[0]?.metadata as { kind?: string; tokens?: { colors?: unknown[] } };
    expect(metadata.kind).toBe("design_system");
    expect(Array.isArray(metadata.tokens?.colors)).toBe(true);
    expect((metadata.tokens?.colors ?? []).length).toBeGreaterThan(0);

    // Audit event records the extraction with the workProductId + colorCount.
    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.design_system_extracted"))
      .then((r) => r[0]);
    expect(audit?.action).toBe("issue.design_system_extracted");
    expect((audit?.details as { workProductId?: string }).workProductId).toBe(workProduct.id);
    expect((audit?.details as { colorCount?: number }).colorCount).toBe(
      designSystem.sourceSummary.colorCount,
    );
  });

  it("accepts a custom title", async () => {
    const { companyId, issueId } = await seed();

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/design-system`)
      .send({ html: SAMPLE_HTML, title: "Marketing site tokens" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.workProduct.title).toBe("Marketing site tokens");
  });

  it("rejects an empty html body via the schema (400)", async () => {
    const { companyId, issueId } = await seed();

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/design-system`)
      .send({ html: "" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    const rows = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId));
    expect(rows).toHaveLength(0);
  });

  it("an agent of the company can extract (designer path)", async () => {
    const { companyId, agentId, issueId } = await seed();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/issues/${issueId}/design-system`)
      .send({ html: SAMPLE_HTML });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.workProduct.type).toBe("design");

    const audit = await db
      .select({ agentId: activityLog.agentId, actorType: activityLog.actorType })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.design_system_extracted"))
      .then((r) => r[0]);
    expect(audit).toMatchObject({ agentId, actorType: "agent" });
  });

  it("returns 404 for a missing issue", async () => {
    const { companyId } = await seed();
    const missingId = randomUUID();

    await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${missingId}/design-system`)
      .send({ html: SAMPLE_HTML })
      .expect(404);
  });

  it("forbids a cross-company agent actor (403)", async () => {
    const { issueId } = await seed();
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();

    const res = await request(createApp(agentActor(otherCompanyId, otherAgentId)))
      .post(`/api/issues/${issueId}/design-system`)
      .send({ html: SAMPLE_HTML });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const rows = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId));
    expect(rows).toHaveLength(0);
  });

  it("forbids an unauthenticated (none) actor (401)", async () => {
    const { issueId } = await seed();

    const res = await request(createApp(noneActor))
      .post(`/api/issues/${issueId}/design-system`)
      .send({ html: SAMPLE_HTML });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
  });
});
