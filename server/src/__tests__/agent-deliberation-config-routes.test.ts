import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// WC-205 (deliberation mode, slice 2): the agent update path accepts + persists
// the per-agent dual-brain `deliberation` config, and a subsequent read returns
// it. Real agentRoutes against embedded Postgres (mirrors
// access-routes-permissions-upgrade.test.ts) so persistence + the validator's
// 400 rejection are asserted against the real route + DB, not mocks.

process.env.WORKCELL_HOME ??= "/tmp/workcell-test-home";
process.env.WORKCELL_INSTANCE_ID ??= "vitest";
process.env.WORKCELL_LOG_DIR ??= "/tmp/workcell-test-home/logs";
process.env.WORKCELL_IN_WORKTREE ??= "false";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-205 deliberation config route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

const validDeliberation = {
  enabled: true,
  brainA: { model: "anthropic/claude-a" },
  brainB: { model: "openai/gpt-b" },
  maxRounds: 5,
};

describeEmbeddedPostgres("WC-205 agent deliberation config routes (slice 2)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  async function makeApp() {
    const { agentRoutes } = await import("../routes/agents.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // local_implicit board actor → allow_local_board for agent_config:* in the
      // real authorization service.
      req.actor = {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        companyIds: [companyId],
        isInstanceAdmin: true,
      } as never;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc205-deliberation-config-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "general",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, activity_log, agent_config_revisions restart identity cascade" as never,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists a deliberation config through PATCH and returns it on a subsequent GET", async () => {
    const app = await makeApp();

    const patchRes = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ deliberation: validDeliberation });
    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
    expect(patchRes.body.deliberation).toMatchObject(validDeliberation);

    // Persisted to the column.
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(row.deliberation).toMatchObject(validDeliberation);

    // And readable through the GET route.
    const getRes = await request(app).get(`/api/agents/${agentId}`);
    expect(getRes.status, JSON.stringify(getRes.body)).toBe(200);
    expect(getRes.body.deliberation).toMatchObject(validDeliberation);
  });

  it("clears deliberation when PATCHed with null", async () => {
    const app = await makeApp();
    await db.update(agents).set({ deliberation: validDeliberation }).where(eq(agents.id, agentId));

    const patchRes = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ deliberation: null });
    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
    expect(patchRes.body.deliberation).toBeNull();

    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(row.deliberation).toBeNull();
  });

  it("rejects a malformed deliberation (maxRounds 0) with 400 and does not mutate the row", async () => {
    const app = await makeApp();

    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        deliberation: {
          enabled: true,
          brainA: { model: null },
          brainB: { model: null },
          maxRounds: 0,
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(400);

    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(row.deliberation ?? null).toBeNull();
  });
});
