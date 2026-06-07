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

// WC-182 / D22: the design-review gate (HTTP API, Slice 2). Exercises the three
// endpoints against the real issueRoutes + workProductService over embedded
// Postgres, injecting board vs agent actors the same way the stale-execution
// lock route test does (mirrors that harness; the attachment route test the
// brief points at is mock-based and cannot drive the real review gate).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-182 design-review gate route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("design-review gate routes (WC-182/D22)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-design-review-routes-");
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

  // Seeds a company + issue + a design-type work product and a non-design one.
  // The issue is intentionally left unassigned so an agent actor passes the
  // agent-mutation guard (assigneeAgentId === null short-circuits to allowed),
  // letting us exercise the designer (agent) submit path without a checkout run.
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

    const [design] = await db
      .insert(issueWorkProducts)
      .values({
        companyId,
        issueId,
        provider: "workcell",
        type: "design",
        title: "design artifact",
        status: "active",
        isPrimary: false,
        reviewState: "none",
      })
      .returning();
    const [proof] = await db
      .insert(issueWorkProducts)
      .values({
        companyId,
        issueId,
        provider: "workcell",
        type: "proof",
        title: "proof artifact",
        status: "active",
        isPrimary: false,
        reviewState: "none",
      })
      .returning();

    return { companyId, agentId, issueId, designId: design.id, proofId: proof.id };
  }

  it("submit (board) → 200, returns needs_board_review and isPrimary true", async () => {
    const { companyId, designId } = await seed();

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/work-products/${designId}/design-review/submit`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reviewState).toBe("needs_board_review");
    expect(res.body.isPrimary).toBe(true);
  });

  it("submit (agent / designer) → 200, returns needs_board_review and isPrimary true", async () => {
    const { companyId, agentId, designId } = await seed();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/work-products/${designId}/design-review/submit`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reviewState).toBe("needs_board_review");
    expect(res.body.isPrimary).toBe(true);
  });

  it("approve (board) after submit → 200, reviewState approved", async () => {
    const { companyId, designId } = await seed();
    const app = createApp(boardActor(companyId));

    await request(app).post(`/api/work-products/${designId}/design-review/submit`).send().expect(200);

    const res = await request(app)
      .post(`/api/work-products/${designId}/design-review/approve`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reviewState).toBe("approved");
  });

  it("approve (board) WITHOUT submit (state none) → 409 invalid transition", async () => {
    const { companyId, designId } = await seed();

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/work-products/${designId}/design-review/approve`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatch(/Invalid design review transition/);
  });

  it("request-changes (board) after submit, with a reason → 200, changes_requested + reason logged", async () => {
    const { companyId, designId } = await seed();
    const app = createApp(boardActor(companyId));

    await request(app).post(`/api/work-products/${designId}/design-review/submit`).send().expect(200);

    const res = await request(app)
      .post(`/api/work-products/${designId}/design-review/request-changes`)
      .send({ reason: "Tighten the spacing on the header" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reviewState).toBe("changes_requested");

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.design_review_changes_requested"))
      .then((rows) => rows[0]);
    expect(audit).toMatchObject({
      action: "issue.design_review_changes_requested",
      details: { workProductId: designId, reason: "Tighten the spacing on the header" },
    });
  });

  it("approve as an AGENT actor → 403 (board required)", async () => {
    const { companyId, agentId, designId } = await seed();
    // Put it in needs_board_review first (so a 403 can only be the board gate,
    // not an invalid-transition conflict).
    await request(createApp(boardActor(companyId)))
      .post(`/api/work-products/${designId}/design-review/submit`)
      .send()
      .expect(200);

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/work-products/${designId}/design-review/approve`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it("request-changes as an AGENT actor → 403 (board required)", async () => {
    const { companyId, agentId, designId } = await seed();
    await request(createApp(boardActor(companyId)))
      .post(`/api/work-products/${designId}/design-review/submit`)
      .send()
      .expect(200);

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/work-products/${designId}/design-review/request-changes`)
      .send({ reason: "nope" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it("submit on the non-design (proof) work product → 422 (not a design type)", async () => {
    const { companyId, proofId } = await seed();

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/work-products/${proofId}/design-review/submit`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toMatch(/not a design type/);
  });

  it("returns 404 for a missing work-product id on every endpoint", async () => {
    const { companyId } = await seed();
    const app = createApp(boardActor(companyId));
    const missingId = randomUUID();

    await request(app).post(`/api/work-products/${missingId}/design-review/submit`).send().expect(404);
    await request(app).post(`/api/work-products/${missingId}/design-review/approve`).send().expect(404);
    await request(app)
      .post(`/api/work-products/${missingId}/design-review/request-changes`)
      .send({ reason: "x" })
      .expect(404);
  });

  // WC-194 (revises WC-192 per user direction — 이전 버전 삭제): approving a
  // design HARD-DELETES the older same-type designs on the same issue, so the
  // catalog keeps exactly one current design per screen.
  it("approving a design hard-deletes older same-type designs on the issue (WC-194)", async () => {
    const { companyId, issueId, designId } = await seed();
    const [older] = await db
      .insert(issueWorkProducts)
      .values({
        companyId,
        issueId,
        provider: "workcell",
        type: "design",
        title: "design artifact v0 (older)",
        status: "active",
        isPrimary: false,
        reviewState: "approved",
      })
      .returning();

    const app = createApp(boardActor(companyId));
    await request(app).post(`/api/work-products/${designId}/design-review/submit`).send().expect(200);
    await request(app).post(`/api/work-products/${designId}/design-review/approve`).send().expect(200);

    // the older same-type design row is gone (hard-deleted)
    const olderRows = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, older.id));
    expect(olderRows.length, "older same-type design should be hard-deleted").toBe(0);

    // the just-approved design itself remains as the live source of truth
    const approvedRow = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, designId))
      .then((r) => r[0]!);
    expect(approvedRow.reviewState).toBe("approved");
  });

  // WC-194: manual hard-delete of a design (board). Irreversible; row removed.
  it("delete a design work product (board) → 200 and the row is gone (WC-194)", async () => {
    const { companyId, designId } = await seed();
    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/work-products/${designId}/delete`)
      .send();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, designId));
    expect(rows.length).toBe(0);
  });

  it("delete on a non-design (proof) work product → 422 (WC-194)", async () => {
    const { companyId, proofId } = await seed();
    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/work-products/${proofId}/delete`)
      .send();
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toMatch(/not a design type/);
  });

  // WC-199 (security): the generic PATCH /work-products/:id is reachable by the
  // issue's assigned agent, so it must NOT accept design reviewState/isPrimary —
  // otherwise an agent could self-approve its own source-of-truth design and walk
  // straight past the board-gated design-first Done gate. Those transitions belong
  // to the /design-review/* routes (submit · approve · request-changes).
  it("PATCH /work-products/:id rejects reviewState/isPrimary on a design → 422 (board-governed)", async () => {
    const { companyId, agentId, designId } = await seed();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .patch(`/api/work-products/${designId}`)
      .send({ reviewState: "approved", isPrimary: true });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("design_review_route_required");

    // the design's reviewState is untouched — never self-approved.
    const row = await db
      .select({ reviewState: issueWorkProducts.reviewState, isPrimary: issueWorkProducts.isPrimary })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, designId))
      .then((r) => r[0]!);
    expect(row.reviewState).toBe("none");
    expect(row.isPrimary).toBe(false);
  });

  // WC-199: the guard is field-specific — non-governed fields (e.g. title) still
  // PATCH normally on a design work product.
  it("PATCH /work-products/:id still updates a design's non-governed field (title) → 200", async () => {
    const { companyId, agentId, designId } = await seed();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .patch(`/api/work-products/${designId}`)
      .send({ title: "renamed design" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("renamed design");
  });
});
