import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues, pairGroups } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-26 pair-group routes embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-26 PairGroup HTTP routes (P2 §3 fourth slice)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let plannerId: string;
  let engineerId: string;

  async function createApp() {
    const actorCompanyId = companyId;
    const [{ pairGroupRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/pair-groups.js")>("../routes/pair-groups.js"),
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
    server.use("/api", pairGroupRoutes(db));
    server.use(errorHandler);
    return server;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc26-pair-group-routes-");
    db = createDb(tempDb.connectionString);
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
    plannerId = randomUUID();
    engineerId = randomUUID();
    await db.insert(agents).values([
      { id: plannerId, companyId, name: "Planner", role: "planner", status: "idle", adapter: "claude_local" },
      { id: engineerId, companyId, name: "Engineer", role: "engineer", status: "idle", adapter: "claude_local" },
    ]);
    app = await createApp();
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, issues, pair_groups, pair_turns, activity_log restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Pair candidate",
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });
    return id;
  }

  it("POST /issues/:id/pair-group creates a group, flips workOwnerKind, then GET returns it", async () => {
    const issueId = await seedIssue();

    const create = await request(app)
      .post(`/api/issues/${issueId}/pair-group`)
      .send({ ownerAgentId: plannerId, counterpartAgentId: engineerId, maxRounds: 5 });
    expect(create.status).toBe(201);
    expect(create.body.group.maxRounds).toBe(5);

    const updated = await db
      .select({ workOwnerKind: issues.workOwnerKind, pairGroupId: issues.pairGroupId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(updated.workOwnerKind).toBe("pair");
    expect(updated.pairGroupId).toBe(create.body.group.id);

    const get = await request(app).get(`/api/issues/${issueId}/pair-group`);
    expect(get.status).toBe(200);
    expect(get.body.group.id).toBe(create.body.group.id);
  });

  it("GET /issues/:id/pair-group exposes runInFlight from the pair-run registry", async () => {
    const issueId = await seedIssue();
    const create = await request(app)
      .post(`/api/issues/${issueId}/pair-group`)
      .send({ ownerAgentId: plannerId, counterpartAgentId: engineerId });
    const groupId = create.body.group.id as string;

    // Idle group → runInFlight false, no source.
    const idle = await request(app).get(`/api/issues/${issueId}/pair-group`);
    expect(idle.status).toBe(200);
    expect(idle.body.group.runInFlight).toBe(false);
    expect(idle.body.group.runInFlightSource).toBeNull();

    // Simulate an in-flight auto-run round by acquiring the shared registry
    // slot directly (the same singleton the route module reads).
    const { pairRunRegistry } = await vi.importActual<
      typeof import("../services/pair-run-registry.js")
    >("../services/pair-run-registry.js");
    expect(pairRunRegistry.tryAcquire(groupId, "auto_run")).toBe(true);
    try {
      const busy = await request(app).get(`/api/issues/${issueId}/pair-group`);
      expect(busy.status).toBe(200);
      expect(busy.body.group.runInFlight).toBe(true);
      expect(busy.body.group.runInFlightSource).toBe("auto_run");
    } finally {
      pairRunRegistry.release(groupId);
    }

    // Released → back to false.
    const settled = await request(app).get(`/api/issues/${issueId}/pair-group`);
    expect(settled.body.group.runInFlight).toBe(false);
  });

  it("POST /issues/:id/pair-group rejects binding an agent from another company (WC-203 tenant isolation)", async () => {
    const issueId = await seedIssue();

    // an unknown agent id → 400, not silently bound
    const unknown = await request(app)
      .post(`/api/issues/${issueId}/pair-group`)
      .send({ ownerAgentId: plannerId, counterpartAgentId: randomUUID() });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(400);
    expect(unknown.body.error).toMatch(/belong to this company/);

    // a REAL agent that belongs to a DIFFERENT company → 400 (cross-tenant bind)
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: "OTH" + otherCompanyId.replace(/-/g, "").slice(0, 4).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    const foreignAgentId = randomUUID();
    await db.insert(agents).values({
      id: foreignAgentId,
      companyId: otherCompanyId,
      name: "Foreign",
      role: "engineer",
      status: "idle",
      adapter: "claude_local",
    });
    const crossTenant = await request(app)
      .post(`/api/issues/${issueId}/pair-group`)
      .send({ ownerAgentId: foreignAgentId });
    expect(crossTenant.status, JSON.stringify(crossTenant.body)).toBe(400);

    // the issue was NOT flipped to pair mode by the rejected request
    const issueRow = await db
      .select({ workOwnerKind: issues.workOwnerKind })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(issueRow.workOwnerKind).not.toBe("pair");
  });

  it("POST /issues/:id/pair-group returns 409 when an active group already exists", async () => {
    const issueId = await seedIssue();
    await request(app).post(`/api/issues/${issueId}/pair-group`).send({});

    const conflict = await request(app).post(`/api/issues/${issueId}/pair-group`).send({});
    expect(conflict.status).toBe(409);
    expect(conflict.body.groupId).toBeTruthy();
  });

  it("POST /issues/:id/pair-group rejects dual_brain (explicit kind and owner===counterpart)", async () => {
    // Phase A: dual-brain self-review is no longer a pair group — it moves to
    // the heartbeat execution layer. The route rejects both forms; agent_pair
    // (two different agents) is unaffected.
    const issueId = await seedIssue();
    const explicit = await request(app)
      .post(`/api/issues/${issueId}/pair-group`)
      .send({ kind: "dual_brain", ownerAgentId: plannerId, counterpartAgentId: plannerId });
    expect(explicit.status).toBe(400);
    expect(explicit.body.code).toBe("dual_brain_not_a_pair_group");

    const inferred = await request(app)
      .post(`/api/issues/${issueId}/pair-group`)
      .send({ ownerAgentId: plannerId, counterpartAgentId: plannerId });
    expect(inferred.status).toBe(400);
    expect(inferred.body.code).toBe("dual_brain_not_a_pair_group");

    // agent_pair (two different agents) still works.
    const pair = await request(app)
      .post(`/api/issues/${issueId}/pair-group`)
      .send({ ownerAgentId: plannerId, counterpartAgentId: engineerId });
    expect(pair.status).toBe(201);
  });

  it("POST /pair-groups/:id/turns records a turn and returns the updated group", async () => {
    const issueId = await seedIssue();
    const create = await request(app)
      .post(`/api/issues/${issueId}/pair-group`)
      .send({ ownerAgentId: plannerId });
    const groupId = create.body.group.id;

    const turn = await request(app)
      .post(`/api/pair-groups/${groupId}/turns`)
      .send({
        actorAgentId: plannerId,
        summary: "First draft",
        outcome: "delivered",
        costCents: 100,
      });
    expect(turn.status).toBe(201);
    expect(turn.body.turn.summary).toBe("First draft");
    expect(turn.body.group.totalCostCents).toBe(100);
  });

  it("POST /pair-groups/:id/advance bumps currentRound", async () => {
    const issueId = await seedIssue();
    const create = await request(app).post(`/api/issues/${issueId}/pair-group`).send({});
    const groupId = create.body.group.id;

    const adv = await request(app).post(`/api/pair-groups/${groupId}/advance`).send({});
    expect(adv.status).toBe(200);
    expect(adv.body.group.currentRound).toBe(1);
  });

  it("PATCH /pair-groups/:id transitions status with a reason", async () => {
    const issueId = await seedIssue();
    const create = await request(app).post(`/api/issues/${issueId}/pair-group`).send({});
    const groupId = create.body.group.id;

    const patch = await request(app)
      .patch(`/api/pair-groups/${groupId}`)
      .send({ status: "completed", stopReason: "agreed_on_solution" });
    expect(patch.status).toBe(200);
    expect(patch.body.group.status).toBe("completed");
    expect(patch.body.group.stopReason).toBe("agreed_on_solution");
  });

  it("GET /pair-groups/:id/turns returns ordered list", async () => {
    const issueId = await seedIssue();
    const create = await request(app)
      .post(`/api/issues/${issueId}/pair-group`)
      .send({ ownerAgentId: plannerId, counterpartAgentId: engineerId });
    const groupId = create.body.group.id;
    await request(app).post(`/api/pair-groups/${groupId}/turns`).send({ actorAgentId: plannerId, summary: "r0-p" });
    await request(app).post(`/api/pair-groups/${groupId}/turns`).send({ actorAgentId: engineerId, summary: "r0-e" });

    const list = await request(app).get(`/api/pair-groups/${groupId}/turns`);
    expect(list.status).toBe(200);
    expect(list.body.turns).toHaveLength(2);
  });

  it("GET /pair-groups/:id/turns returns 404 for an unknown group id", async () => {
    const fake = randomUUID();
    const res = await request(app).get(`/api/pair-groups/${fake}/turns`);
    expect(res.status).toBe(404);
  });
});
