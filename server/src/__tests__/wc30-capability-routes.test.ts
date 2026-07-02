import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-30 capability routes embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-30 Capability Registry HTTP routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let agentId: string;

  async function createApp() {
    const actorCompanyId = companyId;
    const [{ capabilityRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/capabilities.js")>("../routes/capabilities.js"),
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
    server.use("/api", capabilityRoutes(db));
    server.use(errorHandler);
    return server;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc30-capability-routes-");
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
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapter: "claude_local",
    });
    app = await createApp();
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, capabilities, capability_assignments restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("POST then GET /companies/:id/capabilities round-trips", async () => {
    const create = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "k", name: "K", sourceKind: "plugin", trustTier: "trusted" });
    expect(create.status).toBe(201);
    expect(create.body.capability.key).toBe("k");

    const list = await request(app).get(`/api/companies/${companyId}/capabilities`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
  });

  it("POST capabilities requires key/name/sourceKind", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "k" });
    expect(res.status).toBe(400);
  });

  it("POST /capabilities/:id/assign creates an active assignment for trusted cap", async () => {
    const cap = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "k", name: "K", sourceKind: "builtin", trustTier: "trusted" });
    const assign = await request(app)
      .post(`/api/companies/${companyId}/capabilities/${cap.body.capability.id}/assign`)
      .send({ agentId });
    expect(assign.status).toBe(201);
    expect(assign.body.assignment.status).toBe("active");
    expect(assign.body.assignment.agentId).toBe(agentId);
  });

  it("GET /capability-assignments?agentId=<id> returns wide + agent-specific", async () => {
    const capA = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "a", name: "A", sourceKind: "plugin", trustTier: "trusted" });
    const capB = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "b", name: "B", sourceKind: "plugin", trustTier: "trusted" });
    await request(app).post(`/api/companies/${companyId}/capabilities/${capA.body.capability.id}/assign`).send({});
    await request(app).post(`/api/companies/${companyId}/capabilities/${capB.body.capability.id}/assign`).send({ agentId });

    const all = await request(app).get(`/api/companies/${companyId}/capability-assignments?agentId=${agentId}`);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);

    const wideOnly = await request(app).get(`/api/companies/${companyId}/capability-assignments?agentId=null`);
    expect(wideOnly.body.items).toHaveLength(1);
  });

  it("PATCH /capability-assignments/:id transitions status and stamps revoked", async () => {
    const cap = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "k", name: "K", sourceKind: "plugin", trustTier: "trusted" });
    const assign = await request(app)
      .post(`/api/companies/${companyId}/capabilities/${cap.body.capability.id}/assign`)
      .send({});
    const id = assign.body.assignment.id;

    const patch = await request(app)
      .patch(`/api/capability-assignments/${id}`)
      .send({ status: "revoked", notes: "rotation" });
    expect(patch.status).toBe(200);
    expect(patch.body.assignment.status).toBe("revoked");
    expect(patch.body.assignment.revokedAt).not.toBeNull();
    expect(patch.body.assignment.notes).toBe("rotation");
  });

  // WC-36: approval action — pending_approval → active, stamps approverUserId.

  it("WC-36 POST /capability-assignments/:id/approve activates a pending assignment", async () => {
    const cap = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "k", name: "K", sourceKind: "plugin", trustTier: "reviewed" });
    const assign = await request(app)
      .post(`/api/companies/${companyId}/capabilities/${cap.body.capability.id}/assign`)
      .send({});
    expect(assign.body.assignment.status).toBe("pending_approval");

    const approve = await request(app)
      .post(`/api/capability-assignments/${assign.body.assignment.id}/approve`)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.assignment.status).toBe("active");
    expect(approve.body.assignment.grantedByUserId).toBe("local-board");
  });

  it("WC-36 approve returns 409 when the assignment is already active", async () => {
    const cap = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "k", name: "K", sourceKind: "plugin", trustTier: "trusted" });
    const assign = await request(app)
      .post(`/api/companies/${companyId}/capabilities/${cap.body.capability.id}/assign`)
      .send({});
    expect(assign.body.assignment.status).toBe("active");

    const approve = await request(app)
      .post(`/api/capability-assignments/${assign.body.assignment.id}/approve`)
      .send({});
    expect(approve.status).toBe(409);
  });

  it("WC-36 approve returns 404 for unknown assignment id", async () => {
    const res = await request(app)
      .post(`/api/capability-assignments/${randomUUID()}/approve`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("PATCH /capability-assignments/:id without status or visibility returns 400", async () => {
    const cap = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "k", name: "K", sourceKind: "plugin", trustTier: "trusted" });
    const assign = await request(app)
      .post(`/api/companies/${companyId}/capabilities/${cap.body.capability.id}/assign`)
      .send({});
    const res = await request(app)
      .patch(`/api/capability-assignments/${assign.body.assignment.id}`)
      .send({});
    expect(res.status).toBe(400);
  });

  // ---------- WC-51 (security): agent actors must NOT mutate capabilities ----------

  async function createAgentApp() {
    const actorCompanyId = companyId;
    const actorAgentId = agentId;
    const [{ capabilityRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/capabilities.js")>("../routes/capabilities.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: actorAgentId,
        companyId: actorCompanyId,
        companyIds: [actorCompanyId],
        source: "agent_jwt",
        isInstanceAdmin: false,
      };
      next();
    });
    server.use("/api", capabilityRoutes(db));
    server.use(errorHandler);
    return server;
  }

  it("WC-51: agent actor is rejected (403) from register/assign/PATCH", async () => {
    // Board sets up a capability + assignment to PATCH against.
    const cap = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "k", name: "K", sourceKind: "plugin", trustTier: "reviewed" });
    const assign = await request(app)
      .post(`/api/companies/${companyId}/capabilities/${cap.body.capability.id}/assign`)
      .send({});
    const assignmentId = assign.body.assignment.id;

    const agentApp = await createAgentApp();

    const reg = await request(agentApp)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "x", name: "X", sourceKind: "plugin" });
    expect(reg.status).toBe(403);

    // The headline exploit: agent self-grants active, bypassing board approval.
    const selfGrant = await request(agentApp)
      .post(`/api/companies/${companyId}/capabilities/${cap.body.capability.id}/assign`)
      .send({ agentId, status: "active" });
    expect(selfGrant.status).toBe(403);

    const patch = await request(agentApp)
      .patch(`/api/capability-assignments/${assignmentId}`)
      .send({ status: "revoked" });
    expect(patch.status).toBe(403);

    // Read routes stay open to agents (they need to see their own capabilities).
    const readEffective = await request(agentApp).get(
      `/api/companies/${companyId}/agents/${agentId}/effective-capabilities`,
    );
    expect(readEffective.status).toBe(200);
  });

  it("WC-51: board assign derives grantedByUserId from the actor, ignoring the request body", async () => {
    const cap = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "k", name: "K", sourceKind: "plugin", trustTier: "trusted" });
    const assign = await request(app)
      .post(`/api/companies/${companyId}/capabilities/${cap.body.capability.id}/assign`)
      .send({ grantedByUserId: "forged-board-member" });
    expect(assign.status).toBe(201);
    // The body-supplied forged id must be ignored; the actor's id wins.
    expect(assign.body.assignment.grantedByUserId).toBe("local-board");
  });
});
