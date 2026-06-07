import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgeGraphService, type KnowledgeGraphMcpRegistry } from "../services/knowledge-graph.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-110 code-graph routes embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-110 code-graph HTTP routes (D20 S1/S3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc110-code-graph-");
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
    await db.execute("truncate table companies, graph_nodes, graph_edges restart identity cascade" as any);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeApp(opts?: { mcpRegistry?: KnowledgeGraphMcpRegistry; actor?: unknown }) {
    const [{ knowledgeGraphRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/knowledge-graph.js")>("../routes/knowledge-graph.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = opts?.actor ?? {
        type: "board",
        userId: "local-board",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", knowledgeGraphRoutes(db, opts?.mcpRegistry));
    app.use(errorHandler);
    return app;
  }

  const ingestUrl = (id: string) => `/api/companies/${id}/knowledge-graph/code-graph/ingest`;
  const graphifyIngestUrl = (id: string) =>
    `/api/companies/${id}/knowledge-graph/code-graph/ingest-graphify`;
  const neighborsUrl = (id: string) => `/api/companies/${id}/knowledge-graph/code-graph/neighbors`;
  const issueNeighborhoodUrl = (id: string, issueId: string) =>
    `/api/companies/${id}/knowledge-graph/issues/${issueId}/neighborhood`;

  it("WC-110: ingest writes kind=code nodes + edges, then they are listable", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post(ingestUrl(companyId))
      .send({
        nodes: [
          { key: "src/a.ts#f", label: "f", symbolKind: "function" },
          { key: "src/b.ts", label: "b.ts" },
        ],
        edges: [{ fromKey: "src/a.ts#f", toKey: "src/b.ts", kind: "imports" }],
        projectId: "proj-1",
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nodesUpserted: 2, edgesUpserted: 1, edgesSkipped: 0 });

    const list = await request(app).get(`/api/companies/${companyId}/knowledge-graph/nodes?kind=code`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((n: { label: string }) => n.label).sort()).toEqual(["b.ts", "f"]);
  });

  it("WC-110: ingest rejects a payload with no `nodes` array (400)", async () => {
    const app = await makeApp();
    const res = await request(app).post(ingestUrl(companyId)).send({ edges: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("nodes");
  });

  it("WC-110: ingest rejects a node missing key/label (400)", async () => {
    const app = await makeApp();
    const res = await request(app).post(ingestUrl(companyId)).send({ nodes: [{ key: "x" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("key");
  });

  // WC-122 (D20 S4 operational): raw Graphify graph.json → map → ingest.
  // The fixture is the real `graphify update --no-cluster` export shape
  // (graphifyy 0.8.28): NetworkX node-link with `relation` edges.
  it("WC-122: ingest-graphify maps a real graph.json export and persists kind=code nodes", async () => {
    const app = await makeApp();
    const res = await request(app)
      .post(graphifyIngestUrl(companyId))
      .send({
        projectId: "demo-repo",
        graph: {
          nodes: [
            { id: "a", label: "a.js", file_type: "code", source_file: "a.js" },
            { id: "a_greet", label: "greet()", file_type: "code", source_file: "a.js" },
            { id: "b_main", label: "main()", file_type: "code", source_file: "b.js" },
          ],
          links: [
            { source: "a", target: "a_greet", relation: "contains" },
            { source: "b_main", target: "a", relation: "imports_from" },
            { source: "b_main", target: "a_greet", relation: "calls" },
          ],
        },
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      nodesUpserted: 3,
      edgesUpserted: 3,
      edgesSkipped: 0,
      mappedNodes: 3,
      mappedEdges: 3,
    });

    const list = await request(app).get(`/api/companies/${companyId}/knowledge-graph/nodes?kind=code`);
    expect(list.body.items.map((n: { label: string }) => n.label).sort()).toEqual([
      "a.js",
      "greet()",
      "main()",
    ]);
  });

  it("WC-122: ingest-graphify rejects a payload that is not a node-link graph (400)", async () => {
    const app = await makeApp();
    const noGraph = await request(app).post(graphifyIngestUrl(companyId)).send({ projectId: "x" });
    expect(noGraph.status).toBe(400);
    expect(noGraph.body.error).toContain("nodes");

    const notNodeLink = await request(app)
      .post(graphifyIngestUrl(companyId))
      .send({ graph: { foo: "bar" } });
    expect(notNodeLink.status).toBe(400);
  });

  it("WC-122: ingest-graphify is forbidden (403) for a board actor without company access", async () => {
    const app = await makeApp({
      actor: {
        type: "board",
        userId: "u",
        source: "session",
        companyIds: [randomUUID()],
        isInstanceAdmin: false,
        memberships: [],
      },
    });
    const res = await request(app)
      .post(graphifyIngestUrl(companyId))
      .send({ graph: { nodes: [{ id: "x", label: "x" }], links: [] } });
    expect(res.status).toBe(403);
  });

  // WC-123 (D12 S5): issue-centric neighborhood for the UI panel.
  it("WC-123: issue neighborhood joins neighbors with edge kind + direction", async () => {
    const app = await makeApp();
    const svc = knowledgeGraphService(db);
    const issueNode = await svc.registerNode({
      companyId,
      nodeKind: "issue",
      entityRef: "ISSUE-1",
      label: "This issue",
    });
    const parentNode = await svc.registerNode({
      companyId,
      nodeKind: "issue",
      entityRef: "ISSUE-0",
      label: "Parent issue",
    });
    const codeNode = await svc.registerNode({
      companyId,
      nodeKind: "code",
      entityRef: "a_greet",
      label: "greet()",
    });
    // issue --depends_on--> parent (outbound from the issue)
    await svc.registerEdge({
      companyId,
      fromNodeId: issueNode.id,
      toNodeId: parentNode.id,
      edgeKind: "depends_on",
    });
    // code --references--> issue (inbound to the issue)
    await svc.registerEdge({
      companyId,
      fromNodeId: codeNode.id,
      toNodeId: issueNode.id,
      edgeKind: "references",
    });

    const res = await request(app).get(issueNeighborhoodUrl(companyId, "ISSUE-1"));
    expect(res.status).toBe(200);
    expect(res.body.node).toMatchObject({ id: issueNode.id, kind: "issue", label: "This issue" });

    const byRef = Object.fromEntries(
      (res.body.connections as Array<{ entityRef: string }>).map((c) => [c.entityRef, c]),
    );
    expect(byRef["ISSUE-0"]).toMatchObject({
      kind: "issue",
      label: "Parent issue",
      edgeKind: "depends_on",
      direction: "out",
    });
    expect(byRef["a_greet"]).toMatchObject({
      kind: "code",
      label: "greet()",
      edgeKind: "references",
      direction: "in",
    });
  });

  it("WC-123: an issue not yet in the graph returns { node: null, connections: [] } (graceful)", async () => {
    const app = await makeApp();
    const res = await request(app).get(issueNeighborhoodUrl(companyId, "NOT-SYNCED"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ node: null, connections: [] });
  });

  it("WC-110: neighbors overlay is graceful (available:false) when no engine is configured", async () => {
    const app = await makeApp();
    const res = await request(app).get(neighborsUrl(companyId)).query({ ref: "src/a.ts#f" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });

  it("WC-110: neighbors overlay returns engine data when an MCP engine is configured", async () => {
    const callTool = vi.fn(async () => ({ text: JSON.stringify({ neighbors: ["x"] }), isError: false }));
    const app = await makeApp({ mcpRegistry: { callTool } });
    const res = await request(app).get(neighborsUrl(companyId)).query({ ref: "src/a.ts" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, overlay: { neighbors: ["x"] } });
    expect(callTool).toHaveBeenCalledWith(companyId, "code-graph", "get_neighbors", { node: "src/a.ts" });
  });

  it("WC-110: neighbors requires a `ref` query param (400)", async () => {
    const app = await makeApp();
    const res = await request(app).get(neighborsUrl(companyId));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("ref");
  });

  it("WC-110: ingest is forbidden (403) for a board actor without access to the company", async () => {
    const app = await makeApp({
      actor: {
        type: "board",
        userId: "u",
        source: "session",
        companyIds: [randomUUID()],
        isInstanceAdmin: false,
        memberships: [],
      },
    });
    const res = await request(app).post(ingestUrl(companyId)).send({ nodes: [{ key: "x", label: "x" }] });
    expect(res.status).toBe(403);
  });
});
