import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgeGraphService } from "../services/knowledge-graph.ts";
import { mapGraphifyGraphToImport } from "../services/graphify-import.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-28 knowledge graph embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-28 Knowledge Graph PoC service (D12 first slice)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof knowledgeGraphService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc28-knowledge-graph-");
    db = createDb(tempDb.connectionString);
    svc = knowledgeGraphService(db);
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
      "truncate table companies, agents, issues, graph_nodes, graph_edges restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("registerNode is idempotent on (kind, ref) and refreshes label/metadata", async () => {
    const first = await svc.registerNode({
      companyId,
      nodeKind: "issue",
      entityRef: "PAP-1",
      label: "Original title",
      metadata: { status: "todo" },
    });
    const second = await svc.registerNode({
      companyId,
      nodeKind: "issue",
      entityRef: "PAP-1",
      label: "Updated title",
      metadata: { status: "in_progress" },
    });
    expect(second.id).toBe(first.id);
    expect(second.label).toBe("Updated title");
    expect(second.metadata).toEqual({ status: "in_progress" });
  });

  it("registerEdge is idempotent on (from, to, kind)", async () => {
    const a = await svc.registerNode({ companyId, nodeKind: "issue", entityRef: "PAP-1", label: "A" });
    const b = await svc.registerNode({ companyId, nodeKind: "code", entityRef: "src/foo.ts", label: "B" });
    const e1 = await svc.registerEdge({
      companyId,
      fromNodeId: a.id,
      toNodeId: b.id,
      edgeKind: "implements",
    });
    const e2 = await svc.registerEdge({
      companyId,
      fromNodeId: a.id,
      toNodeId: b.id,
      edgeKind: "implements",
    });
    expect(e2.id).toBe(e1.id);

    // A different edge kind between the same pair is a different row.
    const e3 = await svc.registerEdge({
      companyId,
      fromNodeId: a.id,
      toNodeId: b.id,
      edgeKind: "references",
    });
    expect(e3.id).not.toBe(e1.id);
  });

  it("findNode returns null for unknown (kind, ref)", async () => {
    expect(await svc.findNode(companyId, "issue", "nope")).toBeNull();
    await svc.registerNode({ companyId, nodeKind: "issue", entityRef: "PAP-1", label: "A" });
    const found = await svc.findNode(companyId, "issue", "PAP-1");
    expect(found?.label).toBe("A");
  });

  it("neighborhood returns the 1-hop edges + resolved neighbors (outbound + inbound)", async () => {
    const center = await svc.registerNode({ companyId, nodeKind: "issue", entityRef: "PAP-1", label: "center" });
    const out1 = await svc.registerNode({ companyId, nodeKind: "code", entityRef: "src/a.ts", label: "out1" });
    const out2 = await svc.registerNode({ companyId, nodeKind: "code", entityRef: "src/b.ts", label: "out2" });
    const in1 = await svc.registerNode({ companyId, nodeKind: "decision", entityRef: "D7", label: "in1" });
    await svc.registerEdge({ companyId, fromNodeId: center.id, toNodeId: out1.id, edgeKind: "implements" });
    await svc.registerEdge({ companyId, fromNodeId: center.id, toNodeId: out2.id, edgeKind: "implements" });
    await svc.registerEdge({ companyId, fromNodeId: in1.id, toNodeId: center.id, edgeKind: "supersedes" });

    // An unrelated graph chunk that should NOT appear in the neighborhood.
    const isolated = await svc.registerNode({ companyId, nodeKind: "issue", entityRef: "PAP-2", label: "isolated" });
    void isolated;

    const { edges, neighbors } = await svc.neighborhood(companyId, center.id);
    expect(edges).toHaveLength(3);
    const neighborLabels = neighbors.map((n) => n.label).sort();
    expect(neighborLabels).toEqual(["in1", "out1", "out2"]);
  });

  it("listNodesByKind returns only the matching kind for the company", async () => {
    await svc.registerNode({ companyId, nodeKind: "issue", entityRef: "P-1", label: "I1" });
    await svc.registerNode({ companyId, nodeKind: "issue", entityRef: "P-2", label: "I2" });
    await svc.registerNode({ companyId, nodeKind: "code", entityRef: "src/a.ts", label: "C1" });
    const issuesList = await svc.listNodesByKind(companyId, "issue");
    expect(issuesList.map((n) => n.label).sort()).toEqual(["I1", "I2"]);
  });

  // ---------- WC-39: populator ----------

  it("WC-39: syncIssueAsNode mirrors an issue into the graph and refreshes on re-sync", async () => {
    const { issues, agents } = await import("@workcell/db");
    const { randomUUID } = await import("node:crypto");
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "A",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Make foo faster",
      status: "in_progress",
      priority: "high",
      workMode: "standard",
    });

    const node = await svc.syncIssueAsNode(companyId, issueId);
    expect(node?.label).toBe("Make foo faster");
    expect(node?.metadata).toMatchObject({ status: "in_progress", priority: "high" });

    // Update the issue and re-sync — label + metadata refresh.
    await db.update(issues).set({ title: "Make foo a lot faster", status: "done" }).where(eq(issues.id, issueId));
    const refreshed = await svc.syncIssueAsNode(companyId, issueId);
    expect(refreshed?.id).toBe(node?.id);
    expect(refreshed?.label).toBe("Make foo a lot faster");
    expect(refreshed?.metadata).toMatchObject({ status: "done" });

    // Cleanup so the outer afterEach truncate doesn't conflict.
  });

  it("WC-39: syncIssueAsNode auto-creates a parent node + depends_on edge", async () => {
    const { issues, agents } = await import("@workcell/db");
    const { randomUUID } = await import("node:crypto");
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "A",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
    });
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Parent", status: "todo", priority: "medium", workMode: "standard" },
      { id: childId, companyId, title: "Child", status: "todo", priority: "medium", workMode: "standard", parentId },
    ]);

    const child = await svc.syncIssueAsNode(companyId, childId);
    expect(child).toBeTruthy();

    const { edges, neighbors } = await svc.neighborhood(companyId, child!.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].edgeKind).toBe("depends_on");
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].label).toBe("Parent");
  });

  it("WC-39: backfillCompanyIssues processes every issue", async () => {
    const { issues } = await import("@workcell/db");
    const { randomUUID } = await import("node:crypto");
    for (let i = 0; i < 3; i++) {
      await db.insert(issues).values({
        id: randomUUID(),
        companyId,
        title: `Issue ${i}`,
        status: "todo",
        priority: "medium",
        workMode: "standard",
      });
    }
    const result = await svc.backfillCompanyIssues(companyId);
    expect(result.processed).toBe(3);
    const nodes = await svc.listNodesByKind(companyId, "issue");
    expect(nodes).toHaveLength(3);
  });

  // ---------- WC-54 ----------

  it("WC-54: registerNode/registerEdge are idempotent under concurrent calls (no unique-violation throw)", async () => {
    // Fire 5 concurrent registrations of the same node — with the old
    // check-then-insert, the race threw a unique-violation; now ON CONFLICT
    // makes them converge to a single row.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        svc.registerNode({ companyId, nodeKind: "issue", entityRef: "RACE-1", label: "racer" }),
      ),
    );
    const ids = new Set(results.map((n) => n.id));
    expect(ids.size).toBe(1);
    const nodes = await svc.listNodesByKind(companyId, "issue");
    expect(nodes.filter((n) => n.entityRef === "RACE-1")).toHaveLength(1);

    const a = await svc.registerNode({ companyId, nodeKind: "code", entityRef: "src/x.ts", label: "x" });
    const b = await svc.registerNode({ companyId, nodeKind: "code", entityRef: "src/y.ts", label: "y" });
    const edges = await Promise.all(
      Array.from({ length: 5 }, () =>
        svc.registerEdge({ companyId, fromNodeId: a.id, toNodeId: b.id, edgeKind: "references" }),
      ),
    );
    expect(new Set(edges.map((e) => e.id)).size).toBe(1);
  });

  it("WC-54: syncIssueAsNode does NOT mirror a cross-tenant parent", async () => {
    const { issues } = await import("@workcell/db");
    const { randomUUID } = await import("node:crypto");
    // Parent belongs to a DIFFERENT company.
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: "OTHER",
      requireBoardApprovalForNewAgents: false,
    });
    const foreignParentId = randomUUID();
    await db.insert(issues).values({
      id: foreignParentId,
      companyId: otherCompanyId,
      title: "Foreign parent",
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });
    // Child in our company points at the foreign parent (self-FK has no
    // same-company constraint).
    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      title: "Child",
      status: "todo",
      priority: "medium",
      workMode: "standard",
      parentId: foreignParentId,
    });

    const node = await svc.syncIssueAsNode(companyId, childId);
    expect(node).toBeTruthy();
    // The foreign parent must NOT be mirrored, and no edge created.
    const { edges, neighbors } = await svc.neighborhood(companyId, node!.id);
    expect(edges).toHaveLength(0);
    expect(neighbors).toHaveLength(0);
    // Clean up the extra company to keep the truncate teardown FK-safe.
    await db.execute(`truncate table companies, agents, issues, graph_nodes, graph_edges restart identity cascade` as any);
  });

  // ---------- WC-56 ----------

  it("WC-56: syncing a child does NOT clobber an already-synced parent node's metadata", async () => {
    const { issues } = await import("@workcell/db");
    const { randomUUID } = await import("node:crypto");
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Parent", status: "in_progress", priority: "high", workMode: "planning" },
      { id: childId, companyId, title: "Child", status: "todo", priority: "medium", workMode: "standard", parentId },
    ]);

    // Sync the parent FIRST so its node carries full metadata.
    await svc.syncIssueAsNode(companyId, parentId);
    const parentAfterDirect = await svc.findNode(companyId, "issue", parentId);
    expect(parentAfterDirect?.metadata).toMatchObject({
      status: "in_progress",
      priority: "high",
      workMode: "planning",
    });

    // Now sync the CHILD. Before WC-56 the child's parent-upsert passed a
    // sparse { issueId } payload and — because upsertNode always overwrites
    // metadata when provided — downgraded the parent node, dropping
    // status/priority/workMode. The parent must keep its full metadata.
    await svc.syncIssueAsNode(companyId, childId);
    const parentAfterChild = await svc.findNode(companyId, "issue", parentId);
    expect(parentAfterChild?.id).toBe(parentAfterDirect?.id);
    expect(parentAfterChild?.metadata).toMatchObject({
      issueId: parentId,
      status: "in_progress",
      priority: "high",
      workMode: "planning",
    });
  });

  it("WC-56: a parent node created via child-sync alone still gets full metadata", async () => {
    const { issues } = await import("@workcell/db");
    const { randomUUID } = await import("node:crypto");
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Parent", status: "done", priority: "low", workMode: "standard" },
      { id: childId, companyId, title: "Child", status: "todo", priority: "medium", workMode: "standard", parentId },
    ]);

    // Sync ONLY the child — the parent node is created lazily by the
    // parent-upsert. It must carry the parent's FULL metadata, not just
    // { issueId } (which the alternative `metadata: undefined` fix would
    // have left as an empty {} on a fresh stub).
    await svc.syncIssueAsNode(companyId, childId);
    const parent = await svc.findNode(companyId, "issue", parentId);
    expect(parent?.metadata).toMatchObject({
      issueId: parentId,
      status: "done",
      priority: "low",
      workMode: "standard",
    });
  });

  // ---------- WC-63: outbound MCP enrichment (graceful, opt-in) ----------

  it("WC-63: ?enriched without a registry returns the base graph + mcpEnriched=false", async () => {
    const center = await svc.registerNode({ companyId, nodeKind: "issue", entityRef: "E-1", label: "center" });
    // svc has no mcpRegistry configured.
    const result = await svc.neighborhood(companyId, center.id, { enriched: true });
    expect(result.mcpEnriched).toBe(false);
    expect(result.enrichment).toBeUndefined();
    expect(result.edges).toEqual([]);
    expect(result.neighbors).toEqual([]);
  });

  it("WC-63: ?enriched with an available MCP server merges enrichment + mcpEnriched=true", async () => {
    const callTool = vi.fn(async () => ({
      text: JSON.stringify({ external: ["src/foo.ts:42", "doc:design"] }),
      isError: false,
    }));
    const enrichedSvc = knowledgeGraphService(db, { mcpRegistry: { callTool } });
    const center = await enrichedSvc.registerNode({ companyId, nodeKind: "issue", entityRef: "E-2", label: "c2" });

    const result = await enrichedSvc.neighborhood(companyId, center.id, { enriched: true });
    expect(result.mcpEnriched).toBe(true);
    expect(result.enrichment).toEqual({ external: ["src/foo.ts:42", "doc:design"] });
    expect(callTool).toHaveBeenCalledWith(companyId, "graph-enrichment", "enrich", { nodeId: center.id });
  });

  it("WC-63: enrichment degrades gracefully when the MCP call throws (base graph, mcpEnriched=false)", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("mcp_not_authorized");
    });
    const enrichedSvc = knowledgeGraphService(db, { mcpRegistry: { callTool } });
    const center = await enrichedSvc.registerNode({ companyId, nodeKind: "issue", entityRef: "E-3", label: "c3" });

    const result = await enrichedSvc.neighborhood(companyId, center.id, { enriched: true });
    expect(result.mcpEnriched).toBe(false);
    expect(result.enrichment).toBeUndefined();
    // base graph still returned (no throw propagated)
    expect(result.neighbors).toEqual([]);
  });

  it("WC-63: an isError MCP result is treated as no enrichment (mcpEnriched=false)", async () => {
    const callTool = vi.fn(async () => ({ text: "server exploded", isError: true }));
    const enrichedSvc = knowledgeGraphService(db, { mcpRegistry: { callTool } });
    const center = await enrichedSvc.registerNode({ companyId, nodeKind: "issue", entityRef: "E-4", label: "c4" });
    const result = await enrichedSvc.neighborhood(companyId, center.id, { enriched: true });
    expect(result.mcpEnriched).toBe(false);
  });

  it("WC-63: does NOT call the MCP server when enriched is not requested", async () => {
    const callTool = vi.fn(async () => ({ text: "{}", isError: false }));
    const enrichedSvc = knowledgeGraphService(db, { mcpRegistry: { callTool } });
    const center = await enrichedSvc.registerNode({ companyId, nodeKind: "issue", entityRef: "E-5", label: "c5" });
    const result = await enrichedSvc.neighborhood(companyId, center.id);
    expect(result.mcpEnriched).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
  });

  // ---------- WC-107 (D20 / D12 S1): code-graph ingest ----------

  it("WC-107: ingestCodeGraph upserts kind=code nodes + edges with mapped kinds", async () => {
    const result = await svc.ingestCodeGraph(companyId, {
      nodes: [
        { key: "src/a.ts#fa", label: "fa", symbolKind: "function", filePath: "src/a.ts" },
        { key: "src/b.ts#fb", label: "fb", symbolKind: "function", filePath: "src/b.ts" },
        { key: "src/c.ts", label: "c.ts", symbolKind: "file", filePath: "src/c.ts" },
      ],
      edges: [
        { fromKey: "src/a.ts#fa", toKey: "src/b.ts#fb", kind: "calls" }, // -> references
        { fromKey: "src/a.ts#fa", toKey: "src/c.ts", kind: "imports" }, // -> depends_on
      ],
    });
    expect(result).toEqual({ nodesUpserted: 3, edgesUpserted: 2, edgesSkipped: 0 });

    const codeNodes = await svc.listNodesByKind(companyId, "code");
    expect(codeNodes.map((n) => n.label).sort()).toEqual(["c.ts", "fa", "fb"]);

    const fa = await svc.findNode(companyId, "code", "src/a.ts#fa");
    const { edges, neighbors } = await svc.neighborhood(companyId, fa!.id);
    expect(edges.map((e) => e.edgeKind).sort()).toEqual(["depends_on", "references"]);
    expect(edges.every((e) => (e.metadata as { source?: string }).source === "code-graph")).toBe(true);
    expect(neighbors.map((n) => n.label).sort()).toEqual(["c.ts", "fb"]);
  });

  it("WC-121: real graphify export → mapGraphifyGraphToImport → ingestCodeGraph (relations resolve end-to-end)", async () => {
    // Verbatim shape of a real `graphify update --no-cluster` export (graphifyy
    // 0.8.28): NetworkX node-link with `relation` edges. This is the full D20
    // S1+S4 path: Graphify's own JSON, mapped, then persisted as kind=code.
    const realExport = {
      nodes: [
        { id: "a", label: "a.js", file_type: "code", source_file: "a.js" },
        { id: "a_greet", label: "greet()", file_type: "code", source_file: "a.js" },
        { id: "b_main", label: "main()", file_type: "code", source_file: "b.js" },
      ],
      links: [
        { source: "a", target: "a_greet", relation: "contains" }, // -> related
        { source: "b_main", target: "a", relation: "imports_from" }, // -> depends_on
        { source: "b_main", target: "a_greet", relation: "calls" }, // -> references
      ],
    };

    const imported = mapGraphifyGraphToImport(realExport);
    const result = await svc.ingestCodeGraph(companyId, imported, { projectId: "demo-repo" });
    expect(result).toEqual({ nodesUpserted: 3, edgesUpserted: 3, edgesSkipped: 0 });

    // Graphify's `file_type` rode through as symbolKind, `source_file` as filePath.
    const greet = await svc.findNode(companyId, "code", "a_greet");
    expect(greet?.label).toBe("greet()");
    expect((greet?.metadata as { symbolKind?: string; filePath?: string; projectId?: string }))
      .toMatchObject({ symbolKind: "code", filePath: "a.js", projectId: "demo-repo" });

    // The two real Graphify relations I added resolvers for land on the right
    // canonical kinds: contains -> related, imports_from -> depends_on.
    const fileA = await svc.findNode(companyId, "code", "a");
    const aNbr = await svc.neighborhood(companyId, fileA!.id);
    expect(aNbr.edges.find((e) => e.edgeKind === "related")).toBeTruthy(); // a --contains--> a_greet

    const main = await svc.findNode(companyId, "code", "b_main");
    const mainNbr = await svc.neighborhood(companyId, main!.id);
    expect(mainNbr.edges.map((e) => e.edgeKind).sort()).toEqual(["depends_on", "references"]);
  });

  it("WC-107: ingestCodeGraph is idempotent — re-ingest converges (no duplicate nodes/edges)", async () => {
    const graph = {
      nodes: [
        { key: "k1", label: "one" },
        { key: "k2", label: "two" },
      ],
      edges: [{ fromKey: "k1", toKey: "k2", kind: "references" as const }],
    };
    const first = await svc.ingestCodeGraph(companyId, graph);
    const firstNode = await svc.findNode(companyId, "code", "k1");
    const second = await svc.ingestCodeGraph(companyId, { ...graph, nodes: [{ key: "k1", label: "one (renamed)" }, { key: "k2", label: "two" }] });

    expect(first.nodesUpserted).toBe(2);
    expect(second.nodesUpserted).toBe(2);
    const codeNodes = await svc.listNodesByKind(companyId, "code");
    expect(codeNodes).toHaveLength(2); // converged, not duplicated
    const refreshed = await svc.findNode(companyId, "code", "k1");
    expect(refreshed?.id).toBe(firstNode?.id);
    expect(refreshed?.label).toBe("one (renamed)"); // label refreshed
    // single edge row survives the re-ingest
    const { edges } = await svc.neighborhood(companyId, refreshed!.id);
    expect(edges).toHaveLength(1);
  });

  it("WC-107: edge kinds are aliased onto canonical EDGE_KINDS (inherits->implements, default->references)", async () => {
    await svc.ingestCodeGraph(companyId, {
      nodes: [
        { key: "X", label: "X" },
        { key: "Y", label: "Y" },
        { key: "Z", label: "Z" },
      ],
      edges: [
        { fromKey: "X", toKey: "Y", kind: "inherits" }, // -> implements
        { fromKey: "X", toKey: "Z" }, // omitted -> references
      ],
    });
    const x = await svc.findNode(companyId, "code", "X");
    const { edges } = await svc.neighborhood(companyId, x!.id);
    expect(edges.map((e) => e.edgeKind).sort()).toEqual(["implements", "references"]);
  });

  it("WC-107: edges referencing a key absent from nodes are skipped + counted", async () => {
    const result = await svc.ingestCodeGraph(companyId, {
      nodes: [
        { key: "present-1", label: "p1" },
        { key: "present-2", label: "p2" },
      ],
      edges: [
        { fromKey: "present-1", toKey: "present-2" }, // valid
        { fromKey: "present-1", toKey: "ghost" }, // ghost not in nodes -> skipped
      ],
    });
    expect(result).toEqual({ nodesUpserted: 2, edgesUpserted: 1, edgesSkipped: 1 });
    const p1 = await svc.findNode(companyId, "code", "present-1");
    const { edges } = await svc.neighborhood(companyId, p1!.id);
    expect(edges).toHaveLength(1);
  });

  it("WC-107: node metadata carries filePath / symbolKind / projectId", async () => {
    await svc.ingestCodeGraph(
      companyId,
      { nodes: [{ key: "src/m.ts#x", label: "x", symbolKind: "class", filePath: "src/m.ts", metadata: { exported: true } }] },
      { projectId: "proj-7" },
    );
    const node = await svc.findNode(companyId, "code", "src/m.ts#x");
    expect(node?.metadata).toMatchObject({
      filePath: "src/m.ts",
      symbolKind: "class",
      projectId: "proj-7",
      exported: true,
    });
  });

  it("WC-107: ingest is tenant-scoped — the same key in two companies is two distinct nodes", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: "OTHR",
      requireBoardApprovalForNewAgents: false,
    });

    await svc.ingestCodeGraph(companyId, { nodes: [{ key: "shared.ts", label: "ours" }] });
    await svc.ingestCodeGraph(otherCompanyId, { nodes: [{ key: "shared.ts", label: "theirs" }] });

    const ours = await svc.findNode(companyId, "code", "shared.ts");
    const theirs = await svc.findNode(otherCompanyId, "code", "shared.ts");
    expect(ours?.id).not.toBe(theirs?.id);
    expect((await svc.listNodesByKind(companyId, "code")).map((n) => n.label)).toEqual(["ours"]);
    expect((await svc.listNodesByKind(otherCompanyId, "code")).map((n) => n.label)).toEqual(["theirs"]);

    // Keep the truncate teardown FK-safe.
    await db.execute(`truncate table companies, agents, issues, graph_nodes, graph_edges restart identity cascade` as any);
  });

  // ---------- WC-109 (D20 / D12 S3): code-graph query overlay (A1) ----------

  it("WC-109: codeGraphNeighbors without a registry returns { available: false } (graceful)", async () => {
    // svc has no mcpRegistry configured.
    const result = await svc.codeGraphNeighbors(companyId, "src/foo.ts#bar");
    expect(result).toEqual({ available: false, overlay: undefined });
  });

  it("WC-109: codeGraphNeighbors returns the engine overlay + calls the code-graph MCP tool", async () => {
    const callTool = vi.fn(async () => ({
      text: JSON.stringify({ neighbors: ["src/a.ts#x", "src/b.ts#y"] }),
      isError: false,
    }));
    const cgSvc = knowledgeGraphService(db, { mcpRegistry: { callTool } });
    const result = await cgSvc.codeGraphNeighbors(companyId, "src/foo.ts#bar");
    expect(result.available).toBe(true);
    expect(result.overlay).toEqual({ neighbors: ["src/a.ts#x", "src/b.ts#y"] });
    expect(callTool).toHaveBeenCalledWith(companyId, "code-graph", "get_neighbors", { node: "src/foo.ts#bar" });
  });

  it("WC-109: codeGraphNeighbors degrades gracefully when the MCP call throws", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("mcp_not_authorized");
    });
    const cgSvc = knowledgeGraphService(db, { mcpRegistry: { callTool } });
    const result = await cgSvc.codeGraphNeighbors(companyId, "src/foo.ts#bar");
    expect(result).toEqual({ available: false, overlay: undefined });
  });

  it("WC-109: an isError MCP result is treated as no overlay (available: false)", async () => {
    const callTool = vi.fn(async () => ({ text: "engine exploded", isError: true }));
    const cgSvc = knowledgeGraphService(db, { mcpRegistry: { callTool } });
    const result = await cgSvc.codeGraphNeighbors(companyId, "x");
    expect(result.available).toBe(false);
  });

  it("WC-109: a non-JSON payload is returned as the raw overlay text", async () => {
    const callTool = vi.fn(async () => ({ text: "plain-text-pointer", isError: false }));
    const cgSvc = knowledgeGraphService(db, { mcpRegistry: { callTool } });
    const result = await cgSvc.codeGraphNeighbors(companyId, "x");
    expect(result).toEqual({ available: true, overlay: "plain-text-pointer" });
  });

  it("WC-109: a custom query tool name can be supplied", async () => {
    const callTool = vi.fn(async () => ({ text: "{}", isError: false }));
    const cgSvc = knowledgeGraphService(db, { mcpRegistry: { callTool } });
    await cgSvc.codeGraphNeighbors(companyId, "src/foo.ts", { tool: "query_graph" });
    expect(callTool).toHaveBeenCalledWith(companyId, "code-graph", "query_graph", { node: "src/foo.ts" });
  });
});
