import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentMemoryNodes, agents, companies, createDb } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-181 agent-memory routes embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// WC-181 (slice 2): HTTP routes + the agent-only-own-memory authorization gate.
//
// Real service against embedded Postgres (so "no DB mutation" on the 403 path is
// asserted against actual rows), with a per-app injectable `actor` mirroring the
// knowledge-graph route tests (wc110-code-graph-routes.test.ts). The shared
// errorHandler renders thrown HttpErrors (assertCompanyAccess 403 etc.).
describeEmbeddedPostgres("WC-181 agent memory HTTP routes (slice 2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId!: string;
  let otherCompanyId!: string;
  let agentA!: string;
  let agentB!: string;
  let otherCompanyAgent!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc181-agent-memory-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentA = randomUUID();
    agentB = randomUUID();
    otherCompanyAgent = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Workcell",
        issuePrefix: ("AA" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Co",
        issuePrefix: ("BB" + otherCompanyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values([
      makeAgentRow(agentA, companyId, "AgentA"),
      makeAgentRow(agentB, companyId, "AgentB"),
      makeAgentRow(otherCompanyAgent, otherCompanyId, "OtherAgent"),
    ]);
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, agent_memory_nodes, agent_memory_edges restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function makeAgentRow(id: string, agentCompanyId: string, name: string) {
    return {
      id,
      companyId: agentCompanyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    };
  }

  const agentActor = (agentId: string, actorCompanyId: string) => ({
    type: "agent" as const,
    agentId,
    companyId: actorCompanyId,
    source: "agent_key" as const,
  });

  // A board user scoped (via session) to a specific set of companies — exercises
  // the real assertCompanyAccess membership path (not the local_implicit bypass).
  const boardActor = (companyIds: string[]) => ({
    type: "board" as const,
    userId: "board-user",
    source: "session" as const,
    companyIds,
    isInstanceAdmin: false,
    memberships: companyIds.map((id) => ({
      companyId: id,
      membershipRole: "admin",
      status: "active",
    })),
  });

  async function makeApp(actor: unknown) {
    const [{ agentMemoryRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/agent-memory.js")>("../routes/agent-memory.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentMemoryRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const memoryUrl = (agentId: string) => `/api/agents/${agentId}/memory`;
  const nodesUrl = (agentId: string) => `/api/agents/${agentId}/memory/nodes`;
  const edgesUrl = (agentId: string) => `/api/agents/${agentId}/memory/edges`;

  it("agent remembers, recalls, and forgets ITS OWN memory", async () => {
    const app = await makeApp(agentActor(agentA, companyId));

    // Remember (POST node).
    const created = await request(app)
      .post(nodesUrl(agentA))
      .send({ kind: "fact", label: "deploy-target", content: "us-east-1" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ kind: "fact", label: "deploy-target", content: "us-east-1" });
    const nodeId = created.body.id as string;

    // Recall (GET graph).
    const recalled = await request(app).get(memoryUrl(agentA));
    expect(recalled.status).toBe(200);
    expect(recalled.body.nodes).toHaveLength(1);
    expect(recalled.body.edges).toHaveLength(0);
    expect(recalled.body.nodes[0].content).toBe("us-east-1");

    // Forget (DELETE node).
    const forgotten = await request(app).delete(`${nodesUrl(agentA)}/${nodeId}`);
    expect(forgotten.status).toBe(200);
    expect(forgotten.body.id).toBe(nodeId);

    const afterForget = await request(app).get(memoryUrl(agentA));
    expect(afterForget.body.nodes).toHaveLength(0);
  });

  it("agent can link two of its own nodes with an edge, surfaced in the graph", async () => {
    const app = await makeApp(agentActor(agentA, companyId));
    const a = await request(app).post(nodesUrl(agentA)).send({ kind: "fact", label: "a", content: "A" });
    const b = await request(app).post(nodesUrl(agentA)).send({ kind: "entity", label: "b", content: "B" });

    const edge = await request(app)
      .post(edgesUrl(agentA))
      .send({ fromNodeId: a.body.id, toNodeId: b.body.id, relation: "relates_to" });
    expect(edge.status, JSON.stringify(edge.body)).toBe(201);

    const graph = await request(app).get(memoryUrl(agentA));
    expect(graph.body.nodes).toHaveLength(2);
    expect(graph.body.edges).toHaveLength(1);
    expect(graph.body.edges[0]).toMatchObject({ relation: "relates_to" });
  });

  it("agent attempting ANOTHER agent's :agentId is 403 and performs no DB mutation", async () => {
    // Seed a node for the victim (agentB) directly so we can prove it survives.
    const victimApp = await makeApp(agentActor(agentB, companyId));
    const victimNode = await request(victimApp)
      .post(nodesUrl(agentB))
      .send({ kind: "fact", label: "secret", content: "B-only" });
    expect(victimNode.status).toBe(201);

    // agentA's key, but targeting agentB's URL.
    const attackerApp = await makeApp(agentActor(agentA, companyId));

    const readAttempt = await request(attackerApp).get(memoryUrl(agentB));
    expect(readAttempt.status).toBe(403);

    const writeAttempt = await request(attackerApp)
      .post(nodesUrl(agentB))
      .send({ kind: "fact", label: "injected", content: "evil" });
    expect(writeAttempt.status).toBe(403);

    const deleteAttempt = await request(attackerApp).delete(
      `${nodesUrl(agentB)}/${victimNode.body.id}`,
    );
    expect(deleteAttempt.status).toBe(403);

    // No mutation: agentB's row is untouched, and nothing was injected.
    const rows = await db
      .select()
      .from(agentMemoryNodes)
      .where(eq(agentMemoryNodes.agentId, agentB));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("B-only");
    const injected = await db
      .select()
      .from(agentMemoryNodes)
      .where(eq(agentMemoryNodes.label, "injected"));
    expect(injected).toHaveLength(0);
  });

  it("board user reads and writes any IN-COMPANY agent's memory", async () => {
    const app = await makeApp(boardActor([companyId]));

    const created = await request(app)
      .post(nodesUrl(agentA))
      .send({ kind: "preference", label: "tone", content: "terse" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const graph = await request(app).get(memoryUrl(agentA));
    expect(graph.status).toBe(200);
    expect(graph.body.nodes).toHaveLength(1);
    expect(graph.body.nodes[0].label).toBe("tone");

    // Board may manage a DIFFERENT in-company agent too.
    const otherAgentNode = await request(app)
      .post(nodesUrl(agentB))
      .send({ kind: "fact", label: "x", content: "y" });
    expect(otherAgentNode.status).toBe(201);
  });

  it("board user is DENIED access to a cross-company agent's memory", async () => {
    // Board scoped to `companyId` only; otherCompanyAgent belongs to otherCompanyId.
    const app = await makeApp(boardActor([companyId]));

    const readAttempt = await request(app).get(memoryUrl(otherCompanyAgent));
    expect(readAttempt.status).toBe(403);

    const writeAttempt = await request(app)
      .post(nodesUrl(otherCompanyAgent))
      .send({ kind: "fact", label: "x", content: "y" });
    expect(writeAttempt.status).toBe(403);

    const rows = await db
      .select()
      .from(agentMemoryNodes)
      .where(eq(agentMemoryNodes.agentId, otherCompanyAgent));
    expect(rows).toHaveLength(0);
  });

  it("validation: an invalid kind is 400", async () => {
    const app = await makeApp(agentActor(agentA, companyId));
    const res = await request(app)
      .post(nodesUrl(agentA))
      .send({ kind: "bogus", label: "x", content: "y" });
    expect(res.status).toBe(400);
  });

  it("validation: an empty content is 400", async () => {
    const app = await makeApp(agentActor(agentA, companyId));
    const res = await request(app)
      .post(nodesUrl(agentA))
      .send({ kind: "fact", label: "x", content: "" });
    expect(res.status).toBe(400);
  });

  it("deleting a non-existent node is 404", async () => {
    const app = await makeApp(agentActor(agentA, companyId));
    const res = await request(app).delete(`${nodesUrl(agentA)}/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("agent cannot delete another agent's node by passing its OWN :agentId (404, scoped)", async () => {
    // agentB remembers a node.
    const bApp = await makeApp(agentActor(agentB, companyId));
    const bNode = await request(bApp)
      .post(nodesUrl(agentB))
      .send({ kind: "fact", label: "b-secret", content: "B" });
    expect(bNode.status).toBe(201);

    // agentA targets its OWN memory URL (passes the identity gate) but with
    // agentB's nodeId — the service's agent-scoped delete returns null → 404,
    // and agentB's node survives.
    const aApp = await makeApp(agentActor(agentA, companyId));
    const res = await request(aApp).delete(`${nodesUrl(agentA)}/${bNode.body.id}`);
    expect(res.status).toBe(404);

    const rows = await db
      .select()
      .from(agentMemoryNodes)
      .where(eq(agentMemoryNodes.id, bNode.body.id));
    expect(rows).toHaveLength(1);
  });

  it("unauthenticated (actor.type === 'none') is rejected", async () => {
    const app = await makeApp({ type: "none", source: "none" });
    const res = await request(app).get(memoryUrl(agentA));
    // assertCompanyAccess -> assertAuthenticated throws 401.
    expect(res.status).toBe(401);
  });
});
