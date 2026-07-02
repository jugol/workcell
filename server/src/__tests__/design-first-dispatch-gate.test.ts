import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueWorkProducts,
  issues,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { workProductService } from "../services/work-products.ts";

// ── Design-first dispatch gate ──────────────────────────────────────────────
// The HOLD directive in the task prompt was advisory: execution runs kept
// dispatching (and implementing screens) while the issue sat at "awaiting an
// approved 시안". These tests pin the REAL enforcement: an execution run on a
// design-held issue is cancelled BEFORE the adapter executes, a design-request
// child is routed to a designer exactly once, and the gate steps aside for
// designers and approved designs.

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Implemented the screen.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@workcell/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@workcell/shared/telemetry")>(
    "@workcell/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

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
    `Skipping embedded Postgres design-first dispatch gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("design-first dispatch gate", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let heartbeats: Array<ReturnType<typeof heartbeatService>> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-design-first-gate-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    try {
      await Promise.all(heartbeats.map((heartbeat) => heartbeat.__testingDrainActiveRunExecutions()));
      // Let any in-flight runs settle before truncating from under them.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const activeRuns = await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
        if (activeRuns.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    } finally {
      heartbeats = [];
      mockAdapterExecute.mockClear();
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(opts?: { requireDesignFirst?: boolean; withDesigner?: boolean }) {
    const companyId = randomUUID();
    const coderId = randomUUID();
    const designerId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Design First Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      requireDesignFirst: opts?.requireDesignFirst ?? true,
    });
    await db.insert(agents).values([
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      ...(opts?.withDesigner === false
        ? []
        : [
            {
              id: designerId,
              companyId,
              name: "Designer",
              role: "designer" as const,
              status: "idle" as const,
              adapterType: "claude_local" as const,
              adapterConfig: {},
              runtimeConfig: {},
              permissions: {},
            },
          ]),
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Build the onboarding screen",
      status: "todo",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: "manual",
    });
    return { companyId, coderId, designerId, issueId, issuePrefix };
  }

  function createHeartbeat() {
    const heartbeat = heartbeatService(db);
    heartbeats.push(heartbeat);
    return heartbeat;
  }

  async function wakeAndSettle(
    heartbeat: ReturnType<typeof heartbeatService>,
    agentId: string,
    issueId: string,
  ) {
    const runsBefore = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows.length);
    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    // enqueueWakeup returns before the run row lands — wait for THIS agent's new
    // run to exist, then for ALL active runs (incl. the design_request child's
    // designer follow-up) to settle. Waiting for company-wide quiescence (not
    // just this agent's run) is what keeps it deterministic: a fire-and-forget
    // designer wake left running would otherwise race the assertions and the
    // afterEach truncate.
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const runsNow = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .then((rows) => rows.length);
      if (runsNow > runsBefore) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      if (active.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await heartbeat.__testingDrainActiveRunExecutions();
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .orderBy(sql`${heartbeatRuns.createdAt} desc`)
      .then((rows) => rows[0] ?? null);
  }

  // Agent ids the (mocked) adapter actually executed for — the gate's whole
  // contract is WHO runs, not just whether something ran.
  function executedAgentIds() {
    return mockAdapterExecute.mock.calls.map(
      (call) => (call as unknown[])[0] as { agent?: { id?: string } },
    ).map((ctx) => ctx?.agent?.id);
  }

  it(
    "cancels the execution run on a design-held issue and routes ONE design request to the designer",
    async () => {
      const { companyId, coderId, designerId, issueId } = await seed();
      const heartbeat = createHeartbeat();

      const run = await wakeAndSettle(heartbeat, coderId, issueId);
      expect(run?.status).toBe("cancelled");
      expect(run?.errorCode).toBe("design_first_hold");
      // The CODER must never execute — no implementation before an approved
      // 시안. (The designer MAY execute: the gate wakes it for the design task.)
      expect(executedAgentIds()).not.toContain(coderId);

      const designRequests = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "design_request")));
      expect(designRequests).toHaveLength(1);
      expect(designRequests[0]).toMatchObject({
        parentId: issueId,
        originId: issueId,
        assigneeAgentId: designerId,
        priority: "high",
      });
      // The designer wakes immediately and may have checked the task out
      // already (todo → in_progress) — both are healthy, terminal states are not.
      expect(["todo", "in_progress"]).toContain(designRequests[0]?.status);
      // The design task itself must be design-exempt or it would hold forever.
      expect(designRequests[0]?.designRequirement).toMatchObject({ required: false });

      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      expect(comments.some((c) => c.body.includes("Design-first hold"))).toBe(true);

      // Re-wake: still cancelled, still exactly ONE design request (idempotent).
      const secondRun = await wakeAndSettle(heartbeat, coderId, issueId);
      expect(secondRun?.errorCode).toBe("design_first_hold");
      const requestsAfter = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "design_request")));
      expect(requestsAfter).toHaveLength(1);
      expect(executedAgentIds()).not.toContain(coderId);
    },
    120_000,
  );

  it(
    "lets the run through once the source-of-truth design is approved",
    async () => {
      const { companyId, coderId, issueId } = await seed();
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "design",
        provider: "workcell",
        title: "Onboarding screen v1",
        status: "active",
        reviewState: "approved",
        isPrimary: true,
      });
      const heartbeat = createHeartbeat();

      const run = await wakeAndSettle(heartbeat, coderId, issueId);
      expect(run?.errorCode).not.toBe("design_first_hold");
      expect(executedAgentIds()).toContain(coderId);
    },
    120_000,
  );

  it(
    "does not block planning issues or design-exempt issues",
    async () => {
      const { companyId, coderId, issueId } = await seed();
      await db
        .update(issues)
        .set({ designRequirement: { required: false, reason: "backend-only", setByKind: "manual" } })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
      const heartbeat = createHeartbeat();

      const run = await wakeAndSettle(heartbeat, coderId, issueId);
      expect(run?.errorCode).not.toBe("design_first_hold");
      expect(executedAgentIds()).toContain(coderId);
    },
    120_000,
  );

  it(
    "auto-skips operational unblock lock cleanup and does not spawn a design request",
    async () => {
      const { companyId, coderId, issueId } = await seed();
      await db
        .update(issues)
        .set({
          title: "운영 차단 해소: LOR-713 stale checkout 정리",
          description:
            "LOR-713 시안 작업을 풀기 위한 운영 정리 이슈입니다. stale checkout/run-lock and run ownership conflict 해소만 수행합니다.",
        })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
      const heartbeat = createHeartbeat();

      const run = await wakeAndSettle(heartbeat, coderId, issueId);
      expect(run?.errorCode).not.toBe("design_first_hold");
      expect(executedAgentIds()).toContain(coderId);

      const designRequests = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "design_request")));
      expect(designRequests).toHaveLength(0);
    },
    120_000,
  );

  it(
    "honors an explicit design exemption even when an UNAPPROVED 시안 is attached",
    async () => {
      // Regression: a user exempts a backend issue, but a stray unapproved
      // design sits on it. The gate must NOT cancel the run — the exemption
      // wins over the unapproved 시안.
      const { companyId, coderId, issueId } = await seed();
      await db
        .update(issues)
        .set({ designRequirement: { required: false, reason: "backend-only", setByKind: "manual" } })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "design",
        provider: "workcell",
        title: "Stray aspirational mock",
        status: "active",
        reviewState: "needs_board_review",
        isPrimary: true,
      });
      const heartbeat = createHeartbeat();

      const run = await wakeAndSettle(heartbeat, coderId, issueId);
      expect(run?.errorCode).not.toBe("design_first_hold");
      expect(executedAgentIds()).toContain(coderId);
      const designRequests = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "design_request")));
      expect(designRequests).toHaveLength(0);
    },
    120_000,
  );

  it(
    "does not recreate a design request after board approval when the artifact row still says needs_board_review",
    async () => {
      const { companyId, coderId, designerId, issueId, issuePrefix } = await seed();
      const designRequestId = randomUUID();
      const designWorkProductId = "abcdef12-1111-4111-8111-111111111111";
      const approvalId = randomUUID();

      await db.insert(issues).values({
        id: designRequestId,
        companyId,
        parentId: issueId,
        title: "Design 시안: tutorial-start-curriculum",
        status: "done",
        priority: "high",
        workMode: "standard",
        assigneeAgentId: designerId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        originKind: "design_request",
        originId: issueId,
        designRequirement: { required: false, reason: "design request", setByKind: "auto" },
      });
      await db.insert(issueWorkProducts).values({
        id: designWorkProductId,
        companyId,
        issueId: designRequestId,
        type: "design",
        provider: "workcell",
        title: "tutorial-start-curriculum 시안",
        status: "active",
        reviewState: "needs_board_review",
        isPrimary: true,
        screenKey: "tutorial-start-curriculum",
        screenName: "Tutorial start curriculum",
      });
      await db.insert(approvals).values({
        id: approvalId,
        companyId,
        type: "request_board_approval",
        status: "approved",
        payload: {
          title: "Approve design-review 시안",
          summary: `승인된 design artifact work product ${designWorkProductId.slice(0, 8)} for tutorial-start-curriculum 시안`,
          recommendedAction: "승인 후 구현을 재개합니다.",
        },
        decidedByUserId: "board-user",
        decidedAt: new Date(),
      });
      await db.insert(issueApprovals).values({
        companyId,
        issueId: designRequestId,
        approvalId,
        linkedByUserId: "board-user",
      });

      const svc = workProductService(db);
      const gate = await svc.deriveDesignGateForIssue(issueId, companyId);
      expect(gate.developmentHold).toBe(false);
      expect(gate.approved).toBe(true);
      expect(gate.authoritativeDesign?.id).toBe(designWorkProductId);
      expect(gate.authoritativeDesign?.reviewState).toBe("approved");

      const persistedDesign = await db
        .select({ reviewState: issueWorkProducts.reviewState })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, designWorkProductId))
        .then((rows) => rows[0]);
      expect(persistedDesign?.reviewState).toBe("needs_board_review");

      const heartbeat = createHeartbeat();
      const run = await wakeAndSettle(heartbeat, coderId, issueId);
      expect(run?.errorCode).not.toBe("design_first_hold");
      expect(executedAgentIds()).toContain(coderId);

      const designRequests = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "design_request")));
      expect(designRequests).toHaveLength(1);
      expect(designRequests[0]?.id).toBe(designRequestId);
    },
    120_000,
  );

  it(
    "reuses an approved same-screen ancestor design for a new implementation issue without spawning another design request",
    async () => {
      const { companyId, coderId, designerId, issueId: parentIssueId, issuePrefix } = await seed();
      const designRequestId = randomUUID();
      const implementationIssueId = randomUUID();
      const wrongScreenIssueId = randomUUID();
      const approvedDesignId = "2c097208-456e-431f-90c5-4c8a8bdbefc7";

      await db
        .update(issues)
        .set({
          title: "한국어 튜토리얼 시작할 때 커리큘럼 변경",
          description:
            "왕초보 시작 커리큘럼을 글자부터 시작하도록 조정하는 부모 화면 작업입니다.",
        })
        .where(and(eq(issues.id, parentIssueId), eq(issues.companyId, companyId)));
      await db.insert(issues).values([
        {
          id: designRequestId,
          companyId,
          parentId: parentIssueId,
          title: "Design 시안: 한국어 튜토리얼 시작할 때 커리큘럼 변경",
          status: "done",
          priority: "high",
          workMode: "standard",
          assigneeAgentId: designerId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
          originKind: "design_request",
          originId: parentIssueId,
          designRequirement: { required: false, reason: "design request", setByKind: "auto" },
        },
        {
          id: implementationIssueId,
          companyId,
          parentId: parentIssueId,
          title: "구현: 한국어 튜토리얼 시작 커리큘럼 화면 변경",
          description:
            "승인된 source-of-truth 시안을 구현합니다.\n\nscreenKey: `tutorial-start-curriculum`\n\n승인 시안 artifact: `2c097208-456e-431f-90c5-4c8a8bdbefc7`",
          status: "todo",
          priority: "medium",
          workMode: "standard",
          assigneeAgentId: coderId,
          issueNumber: 3,
          identifier: `${issuePrefix}-3`,
          originKind: "manual",
        },
        {
          id: wrongScreenIssueId,
          companyId,
          parentId: parentIssueId,
          title: "구현: 설정 화면 변경",
          description: "screenKey: `settings-page`",
          status: "todo",
          priority: "medium",
          workMode: "standard",
          assigneeAgentId: coderId,
          issueNumber: 4,
          identifier: `${issuePrefix}-4`,
          originKind: "manual",
        },
      ]);
      await db.insert(issueWorkProducts).values({
        id: approvedDesignId,
        companyId,
        issueId: designRequestId,
        type: "design",
        provider: "workcell",
        title: "[LOR-824] 시안: 튜토리얼 시작 — 왕초보 맞춤 커리큘럼 (글자부터 시작)",
        url: "http://example.test/assets/tutorial-start-curriculum.html",
        status: "active",
        reviewState: "approved",
        isPrimary: true,
        screenKey: "tutorial-start-curriculum",
        screenName: "튜토리얼 시작 — 왕초보 맞춤 커리큘럼",
      });

      const svc = workProductService(db);
      const inheritedGate = await svc.deriveDesignGateForIssue(implementationIssueId, companyId);
      expect(inheritedGate.hasDesign).toBe(true);
      expect(inheritedGate.developmentHold).toBe(false);
      expect(inheritedGate.authoritativeDesign?.id).toBe(approvedDesignId);
      expect(inheritedGate.screens).toEqual([
        expect.objectContaining({
          screenKey: "tutorial-start-curriculum",
          workProductId: approvedDesignId,
          approved: true,
        }),
      ]);

      const wrongScreenGate = await svc.deriveDesignGateForIssue(wrongScreenIssueId, companyId);
      expect(wrongScreenGate.hasDesign).toBe(false);
      expect(wrongScreenGate.developmentHold).toBe(true);

      const implementation = await db
        .select({ designRequirement: issues.designRequirement })
        .from(issues)
        .where(eq(issues.id, implementationIssueId))
        .then((rows) => rows[0] ?? null);
      expect(implementation?.designRequirement).toBeNull();

      const heartbeat = createHeartbeat();
      const run = await wakeAndSettle(heartbeat, coderId, implementationIssueId);
      expect(run?.errorCode).not.toBe("design_first_hold");
      expect(executedAgentIds()).toContain(coderId);

      const designRequests = await db
        .select({ id: issues.id, originId: issues.originId })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "design_request")));
      expect(designRequests).toHaveLength(1);
      expect(designRequests[0]?.id).toBe(designRequestId);
      expect(designRequests.some((request) => request.originId === implementationIssueId)).toBe(false);
    },
    120_000,
  );

  it(
    "keeps an approved same-screen ancestor design authoritative when a duplicate child design is still unapproved",
    async () => {
      const { companyId, coderId, designerId, issueId: parentIssueId, issuePrefix } = await seed();
      const approvedDesignRequestId = randomUUID();
      const implementationIssueId = randomUUID();
      const duplicateDesignRequestId = randomUUID();
      const approvedDesignId = "2c097208-456e-431f-90c5-4c8a8bdbefc7";
      const duplicateDesignId = randomUUID();

      await db
        .update(issues)
        .set({
          title: "한국어 튜토리얼 시작할 때 커리큘럼 변경",
          description:
            "왕초보 시작 커리큘럼을 글자부터 시작하도록 조정하는 부모 화면 작업입니다.",
        })
        .where(and(eq(issues.id, parentIssueId), eq(issues.companyId, companyId)));
      await db.insert(issues).values([
        {
          id: approvedDesignRequestId,
          companyId,
          parentId: parentIssueId,
          title: "Design 시안: 한국어 튜토리얼 시작할 때 커리큘럼 변경",
          status: "done",
          priority: "high",
          workMode: "standard",
          assigneeAgentId: designerId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
          originKind: "design_request",
          originId: parentIssueId,
          designRequirement: { required: false, reason: "design request", setByKind: "auto" },
        },
        {
          id: implementationIssueId,
          companyId,
          parentId: parentIssueId,
          title: "구현: 한국어 튜토리얼 시작 커리큘럼을 왕초보 순서로 변경",
          description:
            "승인된 source-of-truth 시안을 구현합니다.\n\nscreenKey: `tutorial-start-curriculum`\n\n승인 시안 artifact: `2c097208-456e-431f-90c5-4c8a8bdbefc7`",
          status: "todo",
          priority: "medium",
          workMode: "standard",
          assigneeAgentId: coderId,
          issueNumber: 3,
          identifier: `${issuePrefix}-3`,
          originKind: "manual",
        },
        {
          id: duplicateDesignRequestId,
          companyId,
          parentId: implementationIssueId,
          title: "Design 시안: 구현: 한국어 튜토리얼 시작 커리큘럼을 왕초보 순서로 변경",
          status: "done",
          priority: "high",
          workMode: "standard",
          assigneeAgentId: designerId,
          issueNumber: 4,
          identifier: `${issuePrefix}-4`,
          originKind: "design_request",
          originId: implementationIssueId,
          designRequirement: { required: false, reason: "design request", setByKind: "auto" },
        },
      ]);
      await db.insert(issueWorkProducts).values([
        {
          id: approvedDesignId,
          companyId,
          issueId: approvedDesignRequestId,
          type: "design",
          provider: "workcell",
          title: "[LOR-824] 시안: 튜토리얼 시작 — 왕초보 맞춤 커리큘럼 (글자부터 시작)",
          url: "http://example.test/assets/tutorial-start-curriculum.html",
          status: "active",
          reviewState: "approved",
          isPrimary: true,
          screenKey: "tutorial-start-curriculum",
          screenName: "튜토리얼 시작 — 왕초보 맞춤 커리큘럼",
        },
        {
          id: duplicateDesignId,
          companyId,
          issueId: duplicateDesignRequestId,
          type: "design",
          provider: "workcell",
          title: "중복 시안: 튜토리얼 시작 — 왕초보 맞춤 커리큘럼",
          url: "http://example.test/assets/tutorial-start-curriculum-duplicate.html",
          status: "active",
          reviewState: "needs_board_review",
          isPrimary: true,
          screenKey: "tutorial-start-curriculum",
          screenName: "튜토리얼 시작 — 왕초보 맞춤 커리큘럼",
        },
      ]);

      const svc = workProductService(db);
      const gate = await svc.deriveDesignGateForIssue(implementationIssueId, companyId);
      expect(gate.hasDesign).toBe(true);
      expect(gate.approved).toBe(true);
      expect(gate.developmentHold).toBe(false);
      expect(gate.authoritativeDesign?.id).toBe(approvedDesignId);
      expect(gate.screens).toEqual([
        expect.objectContaining({
          screenKey: "tutorial-start-curriculum",
          workProductId: approvedDesignId,
          approved: true,
        }),
      ]);

      const designRequestsBefore = await db
        .select({ id: issues.id, originId: issues.originId })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "design_request")));
      expect(designRequestsBefore).toHaveLength(2);
      expect(designRequestsBefore.filter((request) => request.originId === implementationIssueId)).toHaveLength(1);

      const heartbeat = createHeartbeat();
      const run = await wakeAndSettle(heartbeat, coderId, implementationIssueId);
      expect(run?.errorCode).not.toBe("design_first_hold");
      expect(executedAgentIds()).toContain(coderId);

      const designRequestsAfter = await db
        .select({ id: issues.id, originId: issues.originId })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "design_request")));
      expect(designRequestsAfter).toHaveLength(2);
      expect(designRequestsAfter.filter((request) => request.originId === implementationIssueId)).toHaveLength(1);
    },
    120_000,
  );

  it(
    "does not recreate a design request for a projectless design-exempt logic issue with child proof",
    async () => {
      const { companyId, coderId, designerId, issueId, issuePrefix } = await seed();
      const designRequestId = randomUUID();

      await db
        .update(issues)
        .set({
          title: "Fix design gate duplicate requests after board approval",
          description:
            "비화면 로직 버그입니다. design-first gate 중복 design-request 생성을 고칩니다.",
          designRequirement: { required: false, reason: "non-screen logic issue", setByKind: "auto" },
        })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
      await db.insert(issues).values({
        id: designRequestId,
        companyId,
        parentId: issueId,
        title: "Design 시안: duplicate gate logic",
        status: "done",
        priority: "high",
        workMode: "standard",
        assigneeAgentId: designerId,
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
        originKind: "design_request",
        originId: issueId,
        designRequirement: { required: false, reason: "design-exempt follow-up", setByKind: "auto" },
      });
      await db.insert(issueWorkProducts).values({
        id: "6cf88931-6113-4a12-8878-d853b68c4865",
        companyId,
        issueId: designRequestId,
        type: "proof",
        provider: "workcell",
        title: "design-exempt proof",
        status: "active",
      });

      const parent = await db
        .select({
          projectId: issues.projectId,
          designRequirement: issues.designRequirement,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(parent?.projectId).toBeNull();
      expect(parent?.designRequirement).toMatchObject({ required: false });
      expect((await workProductService(db).deriveDesignGateForIssue(issueId, companyId)).developmentHold).toBe(
        false,
      );

      const heartbeat = createHeartbeat();
      const run = await wakeAndSettle(heartbeat, coderId, issueId);
      expect(run?.errorCode).not.toBe("design_first_hold");
      expect(executedAgentIds()).toContain(coderId);

      const designRequests = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "design_request")));
      expect(designRequests).toHaveLength(1);
      expect(designRequests[0]?.id).toBe(designRequestId);
    },
    120_000,
  );

  it(
    "lets a designer agent run on the held issue — producing the 시안 IS the work",
    async () => {
      const { companyId, designerId, issueId } = await seed();
      // The designer owns the issue while designing — assign it over.
      await db
        .update(issues)
        .set({ assigneeAgentId: designerId })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
      const heartbeat = createHeartbeat();

      const run = await wakeAndSettle(heartbeat, designerId, issueId);
      expect(run?.errorCode).not.toBe("design_first_hold");
      expect(executedAgentIds()).toContain(designerId);
    },
    120_000,
  );

  it("WC-201: company-default require_design_first holds UI work but auto-skips non-UI work", async () => {
    const { companyId } = await seed({ requireDesignFirst: true });
    const svc = workProductService(db);
    const mkIssue = async (title: string, designRequirement?: { required: boolean }) => {
      const id = randomUUID();
      await db.insert(issues).values({
        id,
        companyId,
        title,
        status: "todo",
        priority: "medium",
        workMode: "standard",
        issueNumber: Math.floor(Math.random() * 1_000_000) + 10,
        identifier: `X-${id.slice(0, 8)}`,
        originKind: "manual",
        ...(designRequirement ? { designRequirement } : {}),
      });
      return id;
    };

    // Non-UI build/infra issue, company default, no override → NOT held (the bug).
    const nonUi = await mkIssue("make it runnable in an emulator");
    expect((await svc.deriveDesignGateForIssue(nonUi, companyId)).developmentHold).toBe(false);

    // UI/screen issue, company default → held (design-first still applies).
    const ui = await mkIssue("로그인 화면 디자인 반영");
    expect((await svc.deriveDesignGateForIssue(ui, companyId)).developmentHold).toBe(true);

    // Explicit override ALWAYS wins, both directions.
    const forcedNonUi = await mkIssue("backend build script", { required: true });
    expect((await svc.deriveDesignGateForIssue(forcedNonUi, companyId)).developmentHold).toBe(true);
    const exemptUi = await mkIssue("설정 화면", { required: false });
    expect((await svc.deriveDesignGateForIssue(exemptUi, companyId)).developmentHold).toBe(false);
  });
});
