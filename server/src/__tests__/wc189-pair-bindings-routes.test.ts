import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-189 pair-bindings routes embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-189 company pair-bindings route (checkpoint #5)", () => {
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
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc189-pair-bindings-");
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

  async function seedIssue(identifier: string): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Pair candidate",
      identifier,
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });
    return id;
  }

  it("returns an active binding denormalized with agent names + issue ref", async () => {
    const issueId = await seedIssue(`${issuePrefix}-1`);
    const create = await request(app)
      .post(`/api/issues/${issueId}/pair-group`)
      .send({ ownerAgentId: plannerId, counterpartAgentId: engineerId });
    expect(create.status).toBe(201);

    const res = await request(app).get(`/api/companies/${companyId}/pair-groups?status=active`);
    expect(res.status).toBe(200);
    expect(res.body.bindings).toHaveLength(1);
    const binding = res.body.bindings[0];
    expect(binding.ownerAgentId).toBe(plannerId);
    expect(binding.ownerAgentName).toBe("Planner");
    expect(binding.counterpartAgentId).toBe(engineerId);
    expect(binding.counterpartAgentName).toBe("Engineer");
    expect(binding.issueIdentifier).toBe(`${issuePrefix}-1`);
    expect(binding.status).toBe("active");
  });

  it("defaults to active and omits completed groups", async () => {
    const issueId = await seedIssue(`${issuePrefix}-2`);
    const create = await request(app)
      .post(`/api/issues/${issueId}/pair-group`)
      .send({ ownerAgentId: plannerId, counterpartAgentId: engineerId });
    const groupId = create.body.group.id;
    // Move it to completed — it should drop out of the default (active) list.
    await request(app)
      .patch(`/api/pair-groups/${groupId}`)
      .send({ status: "completed", stopReason: "agreed_on_solution" });

    const activeRes = await request(app).get(`/api/companies/${companyId}/pair-groups`);
    expect(activeRes.status).toBe(200);
    expect(activeRes.body.bindings).toHaveLength(0);

    const completedRes = await request(app).get(
      `/api/companies/${companyId}/pair-groups?status=completed`,
    );
    expect(completedRes.status).toBe(200);
    expect(completedRes.body.bindings).toHaveLength(1);
  });

  it("returns an empty list for a company with no pair groups", async () => {
    const res = await request(app).get(`/api/companies/${companyId}/pair-groups?status=active`);
    expect(res.status).toBe(200);
    expect(res.body.bindings).toEqual([]);
  });

  it("rejects an unsupported status with 400", async () => {
    const res = await request(app).get(`/api/companies/${companyId}/pair-groups?status=bogus`);
    expect(res.status).toBe(400);
  });

  // scope=standing: the durable mutually-exclusive pairs that power the
  // assignee picker's merged "Owner ⇄ Counterpart" option.
  describe("scope=standing", () => {
    it("returns the pair even when its only group is aborted, without touching the status listing", async () => {
      const issueId = await seedIssue(`${issuePrefix}-10`);
      const create = await request(app)
        .post(`/api/issues/${issueId}/pair-group`)
        .send({ ownerAgentId: plannerId, counterpartAgentId: engineerId });
      expect(create.status).toBe(201);
      await request(app)
        .patch(`/api/pair-groups/${create.body.group.id}`)
        .send({ status: "aborted", stopReason: "max_rounds_reached" });

      const standing = await request(app).get(
        `/api/companies/${companyId}/pair-groups?scope=standing`,
      );
      expect(standing.status).toBe(200);
      expect(standing.body.bindings).toHaveLength(1);
      expect(standing.body.bindings[0]).toMatchObject({
        ownerAgentId: plannerId,
        ownerAgentName: "Planner",
        counterpartAgentId: engineerId,
        counterpartAgentName: "Engineer",
        status: "aborted",
      });

      // The plain status listing is unchanged by the new scope.
      const active = await request(app).get(`/api/companies/${companyId}/pair-groups`);
      expect(active.status).toBe(200);
      expect(active.body.bindings).toHaveLength(0);
      const aborted = await request(app).get(
        `/api/companies/${companyId}/pair-groups?status=aborted`,
      );
      expect(aborted.body.bindings).toHaveLength(1);
    });

    it("excludes every pair of an agent whose latest groups span two different partners", async () => {
      const designerId = randomUUID();
      await db.insert(agents).values({
        id: designerId,
        companyId,
        name: "Designer",
        role: "designer",
        status: "idle",
        adapter: "claude_local",
      });
      const issueA = await seedIssue(`${issuePrefix}-11`);
      const issueB = await seedIssue(`${issuePrefix}-12`);
      await request(app)
        .post(`/api/issues/${issueA}/pair-group`)
        .send({ ownerAgentId: plannerId, counterpartAgentId: engineerId });
      await request(app)
        .post(`/api/issues/${issueB}/pair-group`)
        .send({ ownerAgentId: plannerId, counterpartAgentId: designerId });

      const standing = await request(app).get(
        `/api/companies/${companyId}/pair-groups?scope=standing`,
      );
      expect(standing.status).toBe(200);
      // Planner's latest bindings span engineer AND designer → no pair of
      // planner's qualifies, and neither counterpart has another partner.
      expect(standing.body.bindings).toEqual([]);
    });

    it("drops a pair whose member is terminated", async () => {
      const issueId = await seedIssue(`${issuePrefix}-13`);
      await request(app)
        .post(`/api/issues/${issueId}/pair-group`)
        .send({ ownerAgentId: plannerId, counterpartAgentId: engineerId });
      await db
        .update(agents)
        .set({ status: "terminated" })
        .where(eq(agents.id, engineerId));

      const standing = await request(app).get(
        `/api/companies/${companyId}/pair-groups?scope=standing`,
      );
      expect(standing.status).toBe(200);
      expect(standing.body.bindings).toEqual([]);
    });

    it("rejects an unsupported scope with 400", async () => {
      const res = await request(app).get(`/api/companies/${companyId}/pair-groups?scope=bogus`);
      expect(res.status).toBe(400);
    });
  });
});
