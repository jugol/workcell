import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { graphEdges, graphNodes, issues } from "@workcell/db";

// WC-28 (D12 first slice): Knowledge Graph PoC service.
//
// Pointer-only graph: nodes reference existing entities, edges express
// typed relationships. No body content here — the canonical source is
// always the referenced entity (issue body in issues.description,
// code at file path, plan content in docs/plan/*).
//
// Operations:
//   - registerNode: idempotent on (kind, ref). Updates label/metadata
//     when re-registered.
//   - registerEdge: idempotent on (from, to, kind).
//   - neighborhood: 1-hop out/in around a node, returned as the
//     resolved neighbor nodes plus the edges that connect them.
export const NODE_KINDS = [
  "issue",
  "code",
  "plan_section",
  "decision",
  "run",
  "skill",
  "plugin",
  "capability",
] as const;
export type GraphNodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "implements",
  "depends_on",
  "references",
  "spawned_by",
  "supersedes",
  "related",
] as const;
export type GraphEdgeKind = (typeof EDGE_KINDS)[number];

// WC-63 (D12): optional outbound MCP enrichment. The capability key the
// registry resolves to an external "graph enrichment" MCP server. Typed
// structurally (just the callTool method we use) to avoid coupling the KG
// service to the registry implementation / a circular import — the real
// mcpClientRegistry (WC-61) satisfies it.
export const GRAPH_ENRICHMENT_MCP_KEY = "graph-enrichment";

// WC-108 (D20 / D12 S2): the capability key the registry resolves to an
// external code-graph ENGINE MCP server (e.g. Graphify `python -m
// graphify.serve`). Distinct from graph-enrichment (which overlays pointers
// onto an existing graph) — this one generates/serves the code graph itself.
export const CODE_GRAPH_MCP_KEY = "code-graph";

export interface KnowledgeGraphMcpRegistry {
  callTool(
    companyId: string,
    mcpKey: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }>;
}

export interface KnowledgeGraphServiceOptions {
  mcpRegistry?: KnowledgeGraphMcpRegistry;
}

export function knowledgeGraphService(
  db: Db,
  options: KnowledgeGraphServiceOptions = {},
) {
  return {
    registerNode: (input: {
      companyId: string;
      nodeKind: GraphNodeKind;
      entityRef: string;
      label: string;
      metadata?: Record<string, unknown>;
    }) => upsertNode(db, input),

    registerEdge: (input: {
      companyId: string;
      fromNodeId: string;
      toNodeId: string;
      edgeKind: GraphEdgeKind;
      metadata?: Record<string, unknown>;
    }) => upsertEdge(db, input),

    findNode: async (companyId: string, nodeKind: GraphNodeKind, entityRef: string) => {
      const rows = await db
        .select()
        .from(graphNodes)
        .where(
          and(
            eq(graphNodes.companyId, companyId),
            eq(graphNodes.nodeKind, nodeKind),
            eq(graphNodes.entityRef, entityRef),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    // 1-hop neighborhood — outbound and inbound edges, plus the
    // referenced neighbor nodes. Useful as the primary "what's connected
    // to this?" query for the navigation UI.
    //
    // WC-63: when opts.enriched is set AND an mcpRegistry is configured, the
    // response is augmented with external pointers from a "graph-enrichment"
    // MCP server. Enrichment is best-effort and GRACEFUL: if the server is
    // unconfigured/unauthorized/errors/times out, the base graph is returned
    // unchanged with mcpEnriched=false (never throws, no timeout surfaced).
    // Stays pointer-only (D12) — enrichment is an ephemeral, non-persisted
    // overlay, not written into graph_nodes/edges.
    neighborhood: async (
      companyId: string,
      nodeId: string,
      opts?: { enriched?: boolean },
    ) => {
      const edges = await db
        .select()
        .from(graphEdges)
        .where(
          and(
            eq(graphEdges.companyId, companyId),
            or(eq(graphEdges.fromNodeId, nodeId), eq(graphEdges.toNodeId, nodeId)),
          ),
        );
      const neighborIds = Array.from(
        new Set(
          edges
            .flatMap((edge) => [edge.fromNodeId, edge.toNodeId])
            .filter((id) => id !== nodeId),
        ),
      );
      const neighbors = neighborIds.length === 0
        ? []
        : await db
            .select()
            .from(graphNodes)
            .where(
              and(
                eq(graphNodes.companyId, companyId),
                inArray(graphNodes.id, neighborIds),
              ),
            );

      if (!opts?.enriched || !options.mcpRegistry) {
        return { edges, neighbors, mcpEnriched: false as boolean, enrichment: undefined as unknown };
      }
      try {
        const res = await options.mcpRegistry.callTool(
          companyId,
          GRAPH_ENRICHMENT_MCP_KEY,
          "enrich",
          { nodeId },
        );
        if (res.isError) {
          return { edges, neighbors, mcpEnriched: false as boolean, enrichment: undefined as unknown };
        }
        let enrichment: unknown = res.text;
        try {
          enrichment = JSON.parse(res.text);
        } catch {
          // keep the raw text if it isn't JSON
        }
        return { edges, neighbors, mcpEnriched: true as boolean, enrichment };
      } catch {
        // Server unconfigured / unauthorized / timeout — degrade gracefully.
        return { edges, neighbors, mcpEnriched: false as boolean, enrichment: undefined as unknown };
      }
    },

    // WC-109 (D20 / D12 S3): ephemeral code-graph query overlay (Option A "A1").
    // Calls the external code-graph ENGINE (CODE_GRAPH_MCP_KEY, e.g. Graphify) to
    // fetch the code entities related to `nodeRef` (a code node's entityRef =
    // the engine's node key). The result is a NON-PERSISTED overlay — never
    // written into graph_nodes/edges (pointer-only, D12). GRACEFUL like WC-63:
    // unconfigured / unauthorized / isError / transport error / timeout all
    // return { available: false }. Never throws.
    codeGraphNeighbors: async (
      companyId: string,
      nodeRef: string,
      opts?: { tool?: string },
    ): Promise<{ available: boolean; overlay: unknown }> => {
      if (!options.mcpRegistry) return { available: false, overlay: undefined };
      try {
        const res = await options.mcpRegistry.callTool(
          companyId,
          CODE_GRAPH_MCP_KEY,
          opts?.tool ?? "get_neighbors",
          { node: nodeRef },
        );
        if (res.isError) return { available: false, overlay: undefined };
        let overlay: unknown = res.text;
        try {
          overlay = JSON.parse(res.text);
        } catch {
          // keep the raw text if it isn't JSON
        }
        return { available: true, overlay };
      } catch {
        // Server unconfigured / unauthorized / timeout — degrade gracefully.
        return { available: false, overlay: undefined };
      }
    },

    listNodesByKind: (companyId: string, nodeKind: GraphNodeKind) =>
      db
        .select()
        .from(graphNodes)
        .where(and(eq(graphNodes.companyId, companyId), eq(graphNodes.nodeKind, nodeKind))),

    // WC-39 (D12 populator): mirror an issue into the graph as a kind="issue"
    // node (+ a depends_on edge to its parent). See syncIssueAsNode below.
    syncIssueAsNode: (companyId: string, issueId: string) =>
      syncIssueAsNode(db, companyId, issueId),

    // WC-39: bulk backfill — sync every issue for a company. Returns the
    // count of nodes created/refreshed.
    // WC-54: calls the module-level syncIssueAsNode directly (previously it
    // re-instantiated the whole service object per iteration via an `as any`
    // cast — wasteful and type-unsafe).
    backfillCompanyIssues: async (companyId: string) => {
      const allIssues = await db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.companyId, companyId));
      let processed = 0;
      for (const issue of allIssues) {
        const result = await syncIssueAsNode(db, companyId, issue.id);
        if (result) processed += 1;
      }
      return { processed };
    },

    // WC-107 (D20 / D12 S1): populate kind="code" nodes (+ edges) from a
    // normalized CodeGraphImport. The boundary contract is OUR neutral shape,
    // decoupled from any specific code-graph engine — a Graphify graph.json ->
    // CodeGraphImport mapper is a separate, engine-coupled slice (D20 S4). See
    // ingestCodeGraph below.
    ingestCodeGraph: (
      companyId: string,
      graph: CodeGraphImport,
      opts?: { projectId?: string },
    ) => ingestCodeGraph(db, companyId, graph, opts),
  };
}

// WC-54: atomic idempotent node upsert. Uses ON CONFLICT on the
// (companyId, nodeKind, entityRef) unique index so concurrent callers
// converge instead of one throwing a unique-violation. Metadata is only
// overwritten when explicitly provided (preserves existing on re-register).
async function upsertNode(
  db: Db,
  input: {
    companyId: string;
    nodeKind: GraphNodeKind;
    entityRef: string;
    label: string;
    metadata?: Record<string, unknown>;
  },
) {
  const set: Record<string, unknown> = { label: input.label, updatedAt: new Date() };
  if (input.metadata !== undefined) set.metadata = input.metadata;
  const [node] = await db
    .insert(graphNodes)
    .values({
      companyId: input.companyId,
      nodeKind: input.nodeKind,
      entityRef: input.entityRef,
      label: input.label,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [graphNodes.companyId, graphNodes.nodeKind, graphNodes.entityRef],
      set,
    })
    .returning();
  return node;
}

// WC-54: atomic idempotent edge upsert on (fromNodeId, toNodeId, edgeKind).
async function upsertEdge(
  db: Db,
  input: {
    companyId: string;
    fromNodeId: string;
    toNodeId: string;
    edgeKind: GraphEdgeKind;
    metadata?: Record<string, unknown>;
  },
) {
  const [edge] = await db
    .insert(graphEdges)
    .values({
      companyId: input.companyId,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      edgeKind: input.edgeKind,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [graphEdges.fromNodeId, graphEdges.toNodeId, graphEdges.edgeKind],
      set: { metadata: input.metadata ?? {} },
    })
    .returning();
  return edge;
}

// WC-56: build the canonical metadata cache for an issue node. Used for
// BOTH the issue's own node and any parent node touched during a child
// sync. Centralizing this is what closes the WC-56 regression: the parent
// upsert previously passed a sparse `{ issueId }` payload which, because
// upsertNode now ALWAYS overwrites metadata when provided, downgraded an
// already-synced parent node — silently dropping its status/priority/
// workMode (order-dependent in backfill, which has no ORDER BY). Both
// call sites now produce the identical full shape so the parent can never
// be clobbered regardless of sync order.
function buildIssueNodeMetadata(issue: {
  id: string;
  status: string;
  priority: string;
  workMode: string;
  parentId: string | null;
}): Record<string, unknown> {
  return {
    issueId: issue.id,
    status: issue.status,
    priority: issue.priority,
    workMode: issue.workMode,
    parentId: issue.parentId,
  };
}

// WC-39/WC-54: mirror an issue into the graph. entityRef = identifier (id
// fallback), label = title, metadata carries status/priority/workMode so
// neighborhood queries can filter without re-joining issues. If the issue
// has a parent, the parent node is ensured and a depends_on edge written.
// All writes are ON CONFLICT upserts so concurrent backfills converge.
async function syncIssueAsNode(db: Db, companyId: string, issueId: string) {
  const issue = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      workMode: issues.workMode,
      parentId: issues.parentId,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .limit(1)
    .then((rows) => rows[0]);
  if (!issue) return null;

  const node = await upsertNode(db, {
    companyId,
    nodeKind: "issue",
    entityRef: issue.identifier ?? issue.id,
    label: issue.title,
    metadata: buildIssueNodeMetadata(issue),
  });

  if (issue.parentId) {
    // WC-54: tenant-scope the parent lookup. Previously this omitted the
    // companyId predicate, so a cross-tenant parent (issues.parentId is a
    // self-FK with no same-company constraint) could be mirrored into the
    // caller's graph under the wrong companyId.
    const parentIssue = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        workMode: issues.workMode,
        parentId: issues.parentId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issue.parentId)))
      .limit(1)
      .then((rows) => rows[0]);
    if (parentIssue) {
      const parentNode = await upsertNode(db, {
        companyId,
        nodeKind: "issue",
        entityRef: parentIssue.identifier ?? parentIssue.id,
        label: parentIssue.title,
        // WC-56: full metadata (not the old sparse `{ issueId }`) so syncing
        // a child never downgrades an already-synced parent node.
        metadata: buildIssueNodeMetadata(parentIssue),
      });
      await upsertEdge(db, {
        companyId,
        fromNodeId: node.id,
        toNodeId: parentNode.id,
        edgeKind: "depends_on",
        metadata: { auto: true },
      });
    }
  }

  return node;
}

// ── WC-107 (D20 / D12 S1): code-graph ingest ────────────────────────────────
// The INGEST half of D20 Option A. The contract below is OUR neutral shape;
// an engine-specific mapper (e.g. Graphify graph.json -> CodeGraphImport) lives
// in a separate, engine-coupled slice so this populator stays decoupled from
// any one code-graph tool and is fully hermetically testable on its own.

/** A code entity (file / symbol / module) to mirror as a kind="code" node. */
export interface CodeGraphNode {
  /** Stable identifier within the company graph (e.g. "src/foo.ts#bar"). Becomes entityRef. */
  key: string;
  /** Human-readable label (symbol or file name). */
  label: string;
  /** Optional code-entity kind hint (e.g. "function", "class", "file", "module"). */
  symbolKind?: string;
  /** Optional source path. */
  filePath?: string;
  /** Extra metadata merged into the node payload. */
  metadata?: Record<string, unknown>;
}

/** Edge kinds accepted on import; code-semantic aliases map onto EDGE_KINDS. */
export type CodeGraphEdgeInputKind =
  | GraphEdgeKind
  | "calls"
  | "imports"
  | "imports_from" // Graphify
  | "contains" // Graphify (file -> symbol)
  | "uses"
  | "inherits"
  | "extends";

export interface CodeGraphEdge {
  fromKey: string;
  toKey: string;
  /** Defaults to "references" when omitted or unrecognized. */
  kind?: CodeGraphEdgeInputKind;
}

export interface CodeGraphImport {
  nodes: CodeGraphNode[];
  edges?: CodeGraphEdge[];
}

export interface CodeGraphIngestResult {
  nodesUpserted: number;
  edgesUpserted: number;
  /** Edges skipped because an endpoint key was absent from `nodes`. */
  edgesSkipped: number;
}

// Map a code-semantic edge kind onto the graph's canonical EDGE_KINDS so the
// rest of the graph (queries, neighborhood) treats code edges uniformly.
function resolveCodeEdgeKind(kind: CodeGraphEdgeInputKind | undefined): GraphEdgeKind {
  switch (kind) {
    case "implements":
    case "inherits":
    case "extends":
      return "implements";
    case "depends_on":
    case "imports":
    case "imports_from":
      return "depends_on";
    case "supersedes":
      return "supersedes";
    case "spawned_by":
      return "spawned_by";
    case "related":
    case "contains":
      return "related";
    case "references":
    case "calls":
    case "uses":
    default:
      return "references";
  }
}

// Idempotent: every node/edge is an ON CONFLICT upsert (same indexes as the
// issue populator), so re-ingesting a regenerated code graph converges instead
// of duplicating. Edges whose endpoints are not both in `nodes` are skipped
// (and counted) rather than silently resolved against the wider graph, keeping
// a single ingest self-contained and deterministic.
async function ingestCodeGraph(
  db: Db,
  companyId: string,
  graph: CodeGraphImport,
  opts?: { projectId?: string },
): Promise<CodeGraphIngestResult> {
  const keyToNodeId = new Map<string, string>();
  let nodesUpserted = 0;

  for (const input of graph.nodes) {
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
    if (input.filePath !== undefined) metadata.filePath = input.filePath;
    if (input.symbolKind !== undefined) metadata.symbolKind = input.symbolKind;
    if (opts?.projectId !== undefined) metadata.projectId = opts.projectId;
    const node = await upsertNode(db, {
      companyId,
      nodeKind: "code",
      entityRef: input.key,
      label: input.label,
      metadata,
    });
    keyToNodeId.set(input.key, node.id);
    nodesUpserted += 1;
  }

  let edgesUpserted = 0;
  let edgesSkipped = 0;
  for (const edge of graph.edges ?? []) {
    const fromNodeId = keyToNodeId.get(edge.fromKey);
    const toNodeId = keyToNodeId.get(edge.toKey);
    if (!fromNodeId || !toNodeId) {
      edgesSkipped += 1;
      continue;
    }
    await upsertEdge(db, {
      companyId,
      fromNodeId,
      toNodeId,
      edgeKind: resolveCodeEdgeKind(edge.kind),
      metadata: { source: "code-graph" },
    });
    edgesUpserted += 1;
  }

  return { nodesUpserted, edgesUpserted, edgesSkipped };
}
