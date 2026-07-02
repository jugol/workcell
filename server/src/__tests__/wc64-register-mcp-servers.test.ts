import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilities, capabilityAssignments, companies, createDb } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerMcpServers } from "../bootstrap/register-mcp-servers.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-64 register-mcp-servers embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-64 registerMcpServers bootstrap (D12/D13)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc64-register-mcp-");
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
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, capabilities, capability_assignments restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function mcpCaps() {
    return db.select().from(capabilities).where(
      and(eq(capabilities.companyId, companyId), eq(capabilities.sourceKind, "mcp")),
    );
  }
  async function companyWideAssignment(capabilityId: string) {
    return db
      .select()
      .from(capabilityAssignments)
      .where(
        and(
          eq(capabilityAssignments.companyId, companyId),
          eq(capabilityAssignments.capabilityId, capabilityId),
          isNull(capabilityAssignments.agentId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  it("registers the known MCP servers as pending_approval when unconfigured", async () => {
    const result = await registerMcpServers(db, companyId, {} as NodeJS.ProcessEnv);
    expect(result.map((r) => r.key).sort()).toEqual(["code-graph", "graph-enrichment", "open-design"]);
    expect(result.every((r) => r.status === "pending_approval" && r.configured === false)).toBe(true);

    const caps = await mcpCaps();
    expect(caps).toHaveLength(3);
    for (const cap of caps) {
      expect(cap.sourceKind).toBe("mcp");
      expect(cap.trustTier).toBe("reviewed");
      const assignment = await companyWideAssignment(cap.id);
      expect(assignment?.status).toBe("pending_approval");
      expect(assignment?.agentId).toBeNull();
    }
  });

  it("registers an ACTIVE assignment + command metadata when the server env is configured", async () => {
    const env = {
      WORKCELL_OPEN_DESIGN_MCP_COMMAND: "node",
      WORKCELL_OPEN_DESIGN_MCP_ARGS: '["od-server.mjs","--read-only"]',
    } as unknown as NodeJS.ProcessEnv;
    const result = await registerMcpServers(db, companyId, env);

    const od = result.find((r) => r.key === "open-design");
    expect(od).toMatchObject({ status: "active", configured: true });
    const graph = result.find((r) => r.key === "graph-enrichment");
    expect(graph).toMatchObject({ status: "pending_approval", configured: false });

    const caps = await mcpCaps();
    const odCap = caps.find((c) => c.key === "open-design")!;
    expect(odCap.metadata).toMatchObject({ command: "node", args: ["od-server.mjs", "--read-only"] });
    expect(odCap.sourceLocator).toBe("node");
    const odAssignment = await companyWideAssignment(odCap.id);
    expect(odAssignment?.status).toBe("active");
  });

  it("is idempotent — re-running does not duplicate capabilities or assignments", async () => {
    await registerMcpServers(db, companyId, {} as NodeJS.ProcessEnv);
    await registerMcpServers(db, companyId, {} as NodeJS.ProcessEnv);
    const caps = await mcpCaps();
    expect(caps).toHaveLength(3); // not 6
    const assignments = await db
      .select()
      .from(capabilityAssignments)
      .where(eq(capabilityAssignments.companyId, companyId));
    expect(assignments).toHaveLength(3); // one company-wide per capability
  });

  it("WC-108: registers the code-graph engine ACTIVE when its env command is configured", async () => {
    const env = {
      WORKCELL_CODE_GRAPH_MCP_COMMAND: "python",
      WORKCELL_CODE_GRAPH_MCP_ARGS: '["-m","graphify.serve","graphify-out/graph.json"]',
    } as unknown as NodeJS.ProcessEnv;
    const result = await registerMcpServers(db, companyId, env);

    const codeGraph = result.find((r) => r.key === "code-graph");
    expect(codeGraph).toMatchObject({ status: "active", configured: true });
    // the other two stay on their graceful pending fallback
    expect(result.find((r) => r.key === "graph-enrichment")).toMatchObject({ status: "pending_approval" });
    expect(result.find((r) => r.key === "open-design")).toMatchObject({ status: "pending_approval" });

    const caps = await mcpCaps();
    const cgCap = caps.find((c) => c.key === "code-graph")!;
    expect(cgCap.metadata).toMatchObject({ command: "python", args: ["-m", "graphify.serve", "graphify-out/graph.json"] });
    expect(cgCap.sourceLocator).toBe("python");
    const cgAssignment = await companyWideAssignment(cgCap.id);
    expect(cgAssignment?.status).toBe("active");
  });

  // ---------- route validation ----------

  it("WC-64: POST /capabilities rejects an 'mcp' capability with no runnable command (400)", async () => {
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const [{ capabilityRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/capabilities.js")>("../routes/capabilities.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.actor = { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use("/api", capabilityRoutes(db));
    app.use(errorHandler);

    const bad = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "x-mcp", name: "X", sourceKind: "mcp", metadata: {} });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("command");

    const ok = await request(app)
      .post(`/api/companies/${companyId}/capabilities`)
      .send({ key: "x-mcp", name: "X", sourceKind: "mcp", metadata: { command: "node" } });
    expect(ok.status).toBe(201);
    expect(ok.body.capability.sourceKind).toBe("mcp");
  });
});
