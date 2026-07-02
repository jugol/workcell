// WC-121 (D20 S4, autonomous half): map a Graphify code-graph export into the
// neutral CodeGraphImport contract (S1) so `ingestCodeGraph` can persist it as
// kind="code" nodes/edges, or the overlay (S3) can serve it.
//
// Graphify builds its graph with NetworkX (tree-sitter AST -> nodes/edges), and
// its default JSON export is NetworkX node-link shape:
//   { "directed"?, "multigraph"?, "graph"?, "nodes": [{ "id", ...attrs }],
//     "links": [{ "source", "target", ...attrs }] }
// (some exporters use "edges" instead of "links"). This mapper handles that
// envelope with FLEXIBLE attribute extraction (common field-name aliases) and
// stashes everything unrecognized into `metadata`, so it degrades gracefully if
// Graphify's exact attribute names differ.
//
// ⚠️ The node-link ENVELOPE (nodes/links/source/target/id) is the verified
// NetworkX standard; the per-node/edge ATTRIBUTE names below are best-effort
// aliases and should be confirmed against a real `graphify` export when the
// Python tool is installed (D20 S4 runtime). Because this is one isolated, fully
// unit-tested function, refining the aliases later is trivial and low-risk.
//
// Pure + no I/O + never throws — a malformed export yields an empty/partial
// import rather than crashing an ingest.

import type { CodeGraphEdge, CodeGraphImport, CodeGraphNode } from "./knowledge-graph.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// First defined string among the given keys (alias resolution).
function pick(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = asString(obj[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

const NODE_ID_KEYS = ["id", "key", "node_id", "nodeId"] as const;
const NODE_LABEL_KEYS = ["label", "name", "title", "qualified_name", "qualifiedName"] as const;
// `file_type` ("code" | "doc" | "image") is Graphify's real node-category field;
// `source_file` is its real path field (verified against a `graphify update`
// export, v0.8.x). The other aliases stay as defensive fallbacks.
const NODE_KIND_KEYS = ["kind", "type", "node_type", "nodeType", "symbol_kind", "symbolKind", "category", "file_type"] as const;
const NODE_PATH_KEYS = ["filePath", "file_path", "file", "path", "relpath", "rel_path", "source_file"] as const;
const EDGE_FROM_KEYS = ["source", "from", "fromKey", "from_id", "src", "u"] as const;
const EDGE_TO_KEYS = ["target", "to", "toKey", "to_id", "dst", "v"] as const;
const EDGE_KIND_KEYS = ["kind", "type", "edge_kind", "edgeKind", "relation", "rel", "label"] as const;

// Keys consumed into typed CodeGraph fields — everything else on the source
// object is preserved under `metadata` so no Graphify attribute is lost.
const NODE_CONSUMED = new Set<string>([...NODE_ID_KEYS, ...NODE_LABEL_KEYS, ...NODE_KIND_KEYS, ...NODE_PATH_KEYS]);
const EDGE_CONSUMED = new Set<string>([...EDGE_FROM_KEYS, ...EDGE_TO_KEYS, ...EDGE_KIND_KEYS]);

function leftoverMetadata(obj: Record<string, unknown>, consumed: Set<string>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!consumed.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mapGraphifyGraphToImport(graph: unknown): CodeGraphImport {
  if (!graph || typeof graph !== "object") return { nodes: [], edges: [] };
  const g = graph as Record<string, unknown>;
  const rawNodes = Array.isArray(g.nodes) ? g.nodes : [];
  // NetworkX node-link uses "links"; some exports use "edges".
  const rawEdges = Array.isArray(g.links) ? g.links : Array.isArray(g.edges) ? g.edges : [];

  const nodes: CodeGraphNode[] = [];
  for (const entry of rawNodes) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const key = pick(e, NODE_ID_KEYS);
    if (!key) continue; // a node without an id cannot be referenced by edges
    const node: CodeGraphNode = { key, label: pick(e, NODE_LABEL_KEYS) ?? key };
    const symbolKind = pick(e, NODE_KIND_KEYS);
    if (symbolKind) node.symbolKind = symbolKind;
    const filePath = pick(e, NODE_PATH_KEYS);
    if (filePath) node.filePath = filePath;
    const metadata = leftoverMetadata(e, NODE_CONSUMED);
    if (metadata) node.metadata = metadata;
    nodes.push(node);
  }

  const edges: CodeGraphEdge[] = [];
  for (const entry of rawEdges) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const fromKey = pick(e, EDGE_FROM_KEYS);
    const toKey = pick(e, EDGE_TO_KEYS);
    if (!fromKey || !toKey) continue;
    const edge: CodeGraphEdge = { fromKey, toKey };
    const kind = pick(e, EDGE_KIND_KEYS);
    if (kind) edge.kind = kind as CodeGraphEdge["kind"];
    edges.push(edge);
  }

  return { nodes, edges };
}
