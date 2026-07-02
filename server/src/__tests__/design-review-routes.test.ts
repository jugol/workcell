import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";

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
    // The design-review wake (approve/request-changes -> heartbeat.wakeup)
    // dispatches for real in this harness and fans out across many
    // company-scoped tables (runs, run events, wakeup requests, environments,
    // leases, company skills, ...). Let in-flight wake runs settle before the
    // truncate, or a fire-and-forget run from one test leaks into the next and
    // makes the suite flaky (it queries heartbeat_runs by agentId).
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      if (active.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // A cascade truncate from the root is the only cleanup that doesn't turn
    // into FK whack-a-mole.
    await db.execute("truncate table companies restart identity cascade" as any);
    await db.execute("truncate table activity_log restart identity cascade" as any);
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

  it("approve wakes the issue assignee — the decision must land on someone", async () => {
    // Regression: the board approved a 시안 and the issue (waiting in review on
    // exactly that approval) never moved — neither approve nor request-changes
    // woke the assignee.
    const { companyId, designId, issueId, agentId } = await seed();
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));
    // Point the agent at a nonexistent adapter so the queued wake run fails at
    // adapter resolution instead of spawning a real CLI — the run ROW (with
    // its wake context) is what this test asserts, not its terminal status.
    await db.update(agents).set({ adapterType: "test_nonexistent_adapter" }).where(eq(agents.id, agentId));
    const app = createApp(boardActor(companyId));

    await request(app).post(`/api/work-products/${designId}/design-review/submit`).send().expect(200);
    await request(app).post(`/api/work-products/${designId}/design-review/approve`).send().expect(200);

    // The wake is fire-and-forget — poll for the queued run.
    const run = await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(rows.length).toBeGreaterThan(0);
      return rows[0];
    }, { timeout: 5000 });
    expect((run.contextSnapshot as Record<string, unknown>)?.designReviewDecision).toBe("approved");
    expect((run.contextSnapshot as Record<string, unknown>)?.issueId).toBe(issueId);

    // The decision rides the wake as a COMMENT, so the woken agent's task
    // prompt says what was decided instead of forcing an API hunt.
    const wakeCommentId = (run.contextSnapshot as Record<string, unknown>)?.wakeCommentId;
    expect(typeof wakeCommentId).toBe("string");
    const comment = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, wakeCommentId as string))
      .then((rows) => rows[0]);
    expect(comment?.issueId).toBe(issueId);
    expect(comment?.body).toContain("approved");
  });

  it("request-changes posts the board's reason as an issue comment and rides it on the wake", async () => {
    const { companyId, designId, issueId, agentId } = await seed();
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));
    await db.update(agents).set({ adapterType: "test_nonexistent_adapter" }).where(eq(agents.id, agentId));
    const app = createApp(boardActor(companyId));

    await request(app).post(`/api/work-products/${designId}/design-review/submit`).send().expect(200);
    await request(app)
      .post(`/api/work-products/${designId}/design-review/request-changes`)
      .send({ reason: "LORO Steps Tutorial Designs (standalone).html 를 반영해서 만들어줘" })
      .expect(200);

    const run = await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(rows.length).toBeGreaterThan(0);
      return rows[0];
    }, { timeout: 5000 });
    const wakeCommentId = (run.contextSnapshot as Record<string, unknown>)?.wakeCommentId;
    expect(typeof wakeCommentId).toBe("string");

    // The reason itself is IN the comment — the agent no longer digs through
    // the activity log to learn what the board asked for.
    const comment = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, wakeCommentId as string))
      .then((rows) => rows[0]);
    expect(comment?.issueId).toBe(issueId);
    expect(comment?.body).toContain("changes requested");
    expect(comment?.body).toContain("LORO Steps Tutorial Designs (standalone).html");
  });

  it("change request wakes the DESIGNER, not the QA reviewer holding the issue in_review", async () => {
    // Regression: during in_review issue.assigneeAgentId is the QA reviewer, so
    // waking the assignee made QA redo the 시안. A design change must re-engage
    // the designer instead.
    const { companyId, designId, issueId, agentId: qaReviewerId } = await seed();
    const designerId = randomUUID();
    await db.insert(agents).values({
      id: designerId,
      companyId,
      name: "Dali",
      role: "designer",
      status: "idle",
      adapterType: "test_nonexistent_adapter",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // The issue sits in_review held by the QA reviewer.
    await db
      .update(issues)
      .set({ assigneeAgentId: qaReviewerId, status: "in_review" })
      .where(eq(issues.id, issueId));
    await db.update(agents).set({ adapterType: "test_nonexistent_adapter" }).where(eq(agents.id, qaReviewerId));
    const app = createApp(boardActor(companyId));

    await request(app).post(`/api/work-products/${designId}/design-review/submit`).send().expect(200);
    await request(app)
      .post(`/api/work-products/${designId}/design-review/request-changes`)
      .send({ reason: "Tighten header spacing" })
      .expect(200);

    // The DESIGNER is woken...
    const designerRun = await vi.waitFor(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, designerId));
      expect(rows.length).toBeGreaterThan(0);
      return rows[0];
    }, { timeout: 5000 });
    expect((designerRun.contextSnapshot as Record<string, unknown>)?.issueId).toBe(issueId);
    expect((designerRun.contextSnapshot as Record<string, unknown>)?.designReviewDecision).toBe("changes_requested");

    // ...and the QA reviewer is NOT.
    const qaRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, qaReviewerId));
    expect(qaRuns.length).toBe(0);
  });

  it("change request prefers the open design_request child's assignee as the designer", async () => {
    const { companyId, designId, issueId, agentId: qaReviewerId } = await seed();
    // Two designers; the one assigned to the design_request child must win over
    // the generic role lookup.
    const childDesignerId = randomUUID();
    const otherDesignerId = randomUUID();
    await db.insert(agents).values([
      { id: otherDesignerId, companyId, name: "Other", role: "designer", status: "idle", adapterType: "test_nonexistent_adapter", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: childDesignerId, companyId, name: "Owner", role: "designer", status: "idle", adapterType: "test_nonexistent_adapter", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Design 시안: Design parent",
      status: "todo",
      priority: "high",
      workMode: "standard",
      assigneeAgentId: childDesignerId,
      originKind: "design_request",
      originId: issueId,
    });
    await db.update(issues).set({ assigneeAgentId: qaReviewerId, status: "in_review" }).where(eq(issues.id, issueId));
    await db.update(agents).set({ adapterType: "test_nonexistent_adapter" }).where(eq(agents.id, qaReviewerId));
    const app = createApp(boardActor(companyId));

    await request(app).post(`/api/work-products/${designId}/design-review/submit`).send().expect(200);
    await request(app).post(`/api/work-products/${designId}/design-review/request-changes`).send({ reason: "redo" }).expect(200);

    const run = await vi.waitFor(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, childDesignerId));
      expect(rows.length).toBeGreaterThan(0);
      return rows[0];
    }, { timeout: 5000 });
    expect(run).toBeTruthy();
    const otherRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, otherDesignerId));
    expect(otherRuns.length).toBe(0);
  });

  // GAP 3 (re-review/rework context): when an execution review stage requests
  // changes back to the implementer, the change-request reason must ride the
  // wake as a comment so the re-engaged implementer's task prompt shows WHAT
  // was requested instead of forcing an activity-log hunt.
  it("execution-stage request_changes rides the reason on the implementer's wake (GAP 3)", async () => {
    const companyId = randomUUID();
    const reviewerId = randomUUID();
    const implementerId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: reviewerId,
        companyId,
        name: "QA",
        role: "engineer",
        status: "active",
        adapterType: "test_nonexistent_adapter",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: implementerId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        adapterType: "test_nonexistent_adapter",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const policy = normalizeIssueExecutionPolicy({
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: stageId,
          type: "review",
          participants: [{ type: "agent", agentId: reviewerId }],
        },
      ],
    })!;
    // The issue sits in_review on the reviewer; the implementer is the return
    // assignee who must address the changes.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Execution review parent",
      status: "in_review",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: reviewerId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId },
        returnAssignee: { type: "agent", agentId: implementerId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    });

    const reason = "Header spacing is off; align the CTA to the 8px grid per the 시안.";
    const res = await request(createApp(agentActor(companyId, reviewerId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: reason });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // The implementer (return assignee) is woken with the change-request...
    const run = await vi.waitFor(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, implementerId));
      expect(rows.length).toBeGreaterThan(0);
      return rows[0];
    }, { timeout: 5000 });
    const snapshot = run.contextSnapshot as Record<string, unknown>;
    expect(snapshot.wakeReason).toBe("execution_changes_requested");

    // ...and the change-request reason rides the wake as a real issue comment.
    const wakeCommentId = snapshot.wakeCommentId;
    expect(typeof wakeCommentId).toBe("string");
    const comment = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, wakeCommentId as string))
      .then((rows) => rows[0]);
    expect(comment?.issueId).toBe(issueId);
    expect(comment?.body).toContain("Header spacing is off");
  });

  // GAP 1+2: the current in_review review participant (QA) can escalate an
  // inadequate approved 시안 back to the designer via design-review/request-changes.
  it("the current in_review review participant (agent) can request design changes → 200 and routes to the DESIGNER", async () => {
    const { companyId, designId, issueId, agentId: reviewerId } = await seed();
    const designerId = randomUUID();
    const stageId = randomUUID();
    await db.insert(agents).values({
      id: designerId,
      companyId,
      name: "Dali",
      role: "designer",
      status: "idle",
      adapterType: "test_nonexistent_adapter",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.update(agents).set({ adapterType: "test_nonexistent_adapter" }).where(eq(agents.id, reviewerId));
    // The reviewer is the CURRENT execution-stage participant of the issue,
    // which sits in_review.
    await db
      .update(issues)
      .set({
        assigneeAgentId: reviewerId,
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerId },
          returnAssignee: { type: "agent", agentId: designerId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: null,
        },
      })
      .where(eq(issues.id, issueId));

    // Board submits first so the gate is in needs_board_review.
    await request(createApp(boardActor(companyId)))
      .post(`/api/work-products/${designId}/design-review/submit`)
      .send()
      .expect(200);

    // The reviewer agent — NOT the board — escalates the design back.
    const res = await request(createApp(agentActor(companyId, reviewerId)))
      .post(`/api/work-products/${designId}/design-review/request-changes`)
      .send({ reason: "The 시안 itself is too cramped — redo with the 8px grid." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reviewState).toBe("changes_requested");

    // The DESIGNER (not the reviewer) is woken to redo the 시안.
    const designerRun = await vi.waitFor(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, designerId));
      expect(rows.length).toBeGreaterThan(0);
      return rows[0];
    }, { timeout: 5000 });
    expect((designerRun.contextSnapshot as Record<string, unknown>)?.designReviewDecision).toBe("changes_requested");
  });

  // SECURITY: the relaxation is scoped to the CURRENT participant only — a
  // different agent (not the review participant) still gets 403.
  it("a non-participant agent requesting design changes → 403", async () => {
    const { companyId, designId, issueId, agentId: reviewerId } = await seed();
    const outsiderId = randomUUID();
    const stageId = randomUUID();
    await db.insert(agents).values({
      id: outsiderId,
      companyId,
      name: "Outsider",
      role: "engineer",
      status: "idle",
      adapterType: "test_nonexistent_adapter",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // The reviewer is the current participant; the issue is in_review.
    await db
      .update(issues)
      .set({
        assigneeAgentId: reviewerId,
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerId },
          returnAssignee: { type: "agent", agentId: reviewerId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: null,
        },
      })
      .where(eq(issues.id, issueId));
    await request(createApp(boardActor(companyId)))
      .post(`/api/work-products/${designId}/design-review/submit`)
      .send()
      .expect(200);

    // The OUTSIDER agent (not the current review participant) is rejected.
    const res = await request(createApp(agentActor(companyId, outsiderId)))
      .post(`/api/work-products/${designId}/design-review/request-changes`)
      .send({ reason: "let me in" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);

    // The design stays in needs_board_review — the unauthorized request did not
    // flip the gate.
    const row = await db
      .select({ reviewState: issueWorkProducts.reviewState })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, designId))
      .then((r) => r[0]!);
    expect(row.reviewState).toBe("needs_board_review");
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

  // GAP 1 (designer self-verify): the submit-time conformance gate runs the
  // stored 시안 HTML through the pure extractDesignSystem() and blocks the
  // obviously-empty case so a blindly-authored, degenerate 시안 can't reach the
  // board.
  async function seedDesignWithUrl(html: string) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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
        url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
      })
      .returning();
    return { companyId, designId: design.id };
  }

  it("submit a 시안 with real colors/fonts → 200 (conformance gate passes)", async () => {
    const realDesign =
      '<!doctype html><html><head><style>body{font-family:Inter,sans-serif;font-size:16px;color:#1a1a1a;background:#ffffff} h1{font-size:32px;color:rgb(79,134,247)}</style></head><body><h1>Hello</h1><button>Go</button></body></html>';
    const { companyId, designId } = await seedDesignWithUrl(realDesign);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/work-products/${designId}/design-review/submit`)
      .send();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reviewState).toBe("needs_board_review");
  });

  it("submit an empty/degenerate 시안 (<html></html>) → 422", async () => {
    const { companyId, designId } = await seedDesignWithUrl("<html></html>");

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/work-products/${designId}/design-review/submit`)
      .send();
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("degenerate_design");

    // The gate ran BEFORE the state flip — the design stays at none.
    const row = await db
      .select({ reviewState: issueWorkProducts.reviewState })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, designId))
      .then((r) => r[0]!);
    expect(row.reviewState).toBe("none");
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
  it("approving a design hard-deletes superseded designs ON THE SAME ISSUE but never a DIFFERENT issue's designs (WC-202 issue-scoped)", async () => {
    const { companyId, issueId, designId } = await seed();
    // WC-202: approving sweeps EVERY non-approved-primary design-type row on the
    // SAME issue (versions pile up otherwise). The safety boundary is the ISSUE:
    // a different SCREEN that must coexist lives on a DIFFERENT issue, which is
    // never touched.
    const [olderSameLineage] = await db
      .insert(issueWorkProducts)
      .values({
        companyId,
        issueId,
        provider: "workcell",
        type: "design",
        title: "design artifact v0",
        status: "active",
        isPrimary: false,
        reviewState: "approved",
      })
      .returning();
    // A DIFFERENT issue's design — the issue-scope safety boundary — must SURVIVE.
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Other screen issue",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: null,
    });
    const [otherScreen] = await db
      .insert(issueWorkProducts)
      .values({
        companyId,
        issueId: otherIssueId,
        provider: "workcell",
        type: "design",
        title: "Dashboard 시안",
        status: "active",
        isPrimary: false,
        reviewState: "approved",
      })
      .returning();

    const app = createApp(boardActor(companyId));
    await request(app).post(`/api/work-products/${designId}/design-review/submit`).send().expect(200);
    await request(app).post(`/api/work-products/${designId}/design-review/approve`).send().expect(200);

    // the superseded design row on the SAME issue is gone (hard-deleted)
    const olderRows = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, olderSameLineage.id));
    expect(olderRows.length, "superseded same-issue design should be hard-deleted").toBe(0);

    // a DIFFERENT issue's design survives (issue-scope boundary)
    const otherRows = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, otherScreen.id));
    expect(otherRows.length, "a different issue's design must survive").toBe(1);

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
