import { api } from "./client";

// WC-181 (slice 3 UI): typed client for the per-agent memory graph routes
// (server/src/routes/agent-memory.ts). Methods mirror the routes 1:1.
//
// Unlike the company-scoped Knowledge Graph (a pointer index), these nodes STORE
// CONTENT — `content` is the actual remembered text. Every node/edge is agent-
// AND company-scoped; a board user may read AND manage any agent's memory within
// their company via these same endpoints, so the UI just calls them with the
// normal session.

// The validated memory kinds (server: MEMORY_NODE_KINDS). Kept as a const tuple
// so the UI can colour/label by kind exhaustively; `string` fallbacks are still
// tolerated at render time because the DB column is an open enum.
export const MEMORY_NODE_KINDS = [
  "fact",
  "preference",
  "entity",
  "decision",
  "todo",
  "other",
] as const;
export type MemoryNodeKind = (typeof MEMORY_NODE_KINDS)[number];

// Raw DB rows as returned by GET /agents/:agentId/memory. Timestamps are ISO
// strings over the wire; metadata is a free-form bag.
export interface AgentMemoryNode {
  id: string;
  companyId: string;
  agentId: string;
  kind: MemoryNodeKind | string;
  label: string;
  /** The remembered text. */
  content: string;
  metadata: Record<string, unknown> | null;
  /** Provenance: the heartbeat run that produced/last-touched this memory. */
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMemoryEdge {
  id: string;
  companyId: string;
  agentId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentMemoryGraph {
  nodes: AgentMemoryNode[];
  edges: AgentMemoryEdge[];
}

export interface UpsertMemoryNodeBody {
  kind: MemoryNodeKind | string;
  label: string;
  content: string;
  metadata?: Record<string, unknown>;
  sourceRunId?: string | null;
}

export interface CreateMemoryEdgeBody {
  fromNodeId: string;
  toNodeId: string;
  relation: string;
  metadata?: Record<string, unknown>;
}

export const agentMemoryApi = {
  // Recall: the agent's whole memory graph { nodes, edges }.
  getMemoryGraph: (agentId: string) =>
    api.get<AgentMemoryGraph>(`/agents/${agentId}/memory`),

  // Remember: idempotent upsert of a memory node (returns 201 upserted node).
  upsertMemoryNode: (agentId: string, body: UpsertMemoryNodeBody) =>
    api.post<AgentMemoryNode>(`/agents/${agentId}/memory/nodes`, body),

  // Forget a node (cascades its incident edges; 404 if not found).
  deleteMemoryNode: (agentId: string, nodeId: string) =>
    api.delete<AgentMemoryNode>(`/agents/${agentId}/memory/nodes/${nodeId}`),

  // Link: idempotent typed edge between two of the agent's nodes.
  createMemoryEdge: (agentId: string, body: CreateMemoryEdgeBody) =>
    api.post<AgentMemoryEdge>(`/agents/${agentId}/memory/edges`, body),

  // Forget an edge (404 if not found).
  deleteMemoryEdge: (agentId: string, edgeId: string) =>
    api.delete<AgentMemoryEdge>(`/agents/${agentId}/memory/edges/${edgeId}`),
};
