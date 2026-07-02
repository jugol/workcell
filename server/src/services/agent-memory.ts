import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { agentMemoryEdges, agentMemoryNodes } from "@workcell/db";

// WC-181 (slice 1): per-agent memory graph service.
//
// Agent-scoped, content-storing counterpart to the company-scoped Knowledge
// Graph (knowledge-graph.ts). Nodes carry the actual remembered text in
// `content`; edges express typed relations between an agent's own memories.
//
// Tenant + agent isolation is the load-bearing invariant: EVERY query filters
// on BOTH companyId AND agentId, so agent A can never read, mutate, or delete
// agent B's memories — even within the same company.
//
// Operations:
//   - upsertNode: idempotent on (companyId, agentId, kind, label). Re-
//     remembering the same labelled fact updates content/metadata/sourceRunId
//     in place instead of duplicating (ON CONFLICT on the unique index).
//   - createEdge: idempotent on (fromNodeId, toNodeId, relation) — re-linking
//     the same pair with the same relation is a no-op (onConflictDoNothing).
//   - listGraph: the agent's whole memory graph { nodes, edges }.
//   - deleteNode / deleteEdge: agent-scoped removal; deleting a node cascades
//     its incident edges (DB-level ON DELETE CASCADE, migration 0109).
export const MEMORY_NODE_KINDS = [
  "fact",
  "preference",
  "entity",
  "decision",
  "todo",
  "other",
] as const;
export type AgentMemoryNodeKind = (typeof MEMORY_NODE_KINDS)[number];

function isMemoryNodeKind(value: string): value is AgentMemoryNodeKind {
  return (MEMORY_NODE_KINDS as readonly string[]).includes(value);
}

function assertMemoryNodeKind(kind: string): AgentMemoryNodeKind {
  if (!isMemoryNodeKind(kind)) {
    throw new Error(
      `Invalid agent memory node kind '${kind}'. Expected one of: ${MEMORY_NODE_KINDS.join(", ")}`,
    );
  }
  return kind;
}

export interface UpsertMemoryNodeInput {
  companyId: string;
  agentId: string;
  kind: AgentMemoryNodeKind;
  label: string;
  content: string;
  metadata?: Record<string, unknown>;
  sourceRunId?: string | null;
}

export interface CreateMemoryEdgeInput {
  companyId: string;
  agentId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: string;
  metadata?: Record<string, unknown>;
}

export function agentMemoryService(db: Db) {
  return {
    // Idempotent node upsert. ON CONFLICT on the (companyId, agentId, kind,
    // label) unique index so concurrent callers converge instead of one
    // throwing a unique-violation. content is always refreshed; metadata /
    // sourceRunId are only overwritten when explicitly provided (preserves the
    // existing value on a partial re-remember).
    upsertNode: (input: UpsertMemoryNodeInput) => upsertNode(db, input),

    // Idempotent edge create on (fromNodeId, toNodeId, relation). Re-linking is
    // a no-op (onConflictDoNothing) — returns the existing edge.
    createEdge: (input: CreateMemoryEdgeInput) => createEdge(db, input),

    // The agent's entire memory graph. Both queries are tenant + agent scoped.
    listGraph: async (companyId: string, agentId: string) => {
      const nodes = await db
        .select()
        .from(agentMemoryNodes)
        .where(
          and(
            eq(agentMemoryNodes.companyId, companyId),
            eq(agentMemoryNodes.agentId, agentId),
          ),
        );
      const edges = await db
        .select()
        .from(agentMemoryEdges)
        .where(
          and(
            eq(agentMemoryEdges.companyId, companyId),
            eq(agentMemoryEdges.agentId, agentId),
          ),
        );
      return { nodes, edges };
    },

    // Agent-scoped node delete. Incident edges cascade away via the DB-level
    // ON DELETE CASCADE on agent_memory_edges.from/to_node_id (migration 0109).
    // Returns the deleted node, or null if it did not belong to this agent.
    deleteNode: async (companyId: string, agentId: string, nodeId: string) => {
      const deleted = await db
        .delete(agentMemoryNodes)
        .where(
          and(
            eq(agentMemoryNodes.companyId, companyId),
            eq(agentMemoryNodes.agentId, agentId),
            eq(agentMemoryNodes.id, nodeId),
          ),
        )
        .returning();
      return deleted[0] ?? null;
    },

    // Agent-scoped edge delete. Returns the deleted edge, or null if it did not
    // belong to this agent.
    deleteEdge: async (companyId: string, agentId: string, edgeId: string) => {
      const deleted = await db
        .delete(agentMemoryEdges)
        .where(
          and(
            eq(agentMemoryEdges.companyId, companyId),
            eq(agentMemoryEdges.agentId, agentId),
            eq(agentMemoryEdges.id, edgeId),
          ),
        )
        .returning();
      return deleted[0] ?? null;
    },

    // Convenience read used by tests / callers that want a single node by id,
    // still tenant + agent scoped.
    getNode: async (companyId: string, agentId: string, nodeId: string) => {
      const rows = await db
        .select()
        .from(agentMemoryNodes)
        .where(
          and(
            eq(agentMemoryNodes.companyId, companyId),
            eq(agentMemoryNodes.agentId, agentId),
            eq(agentMemoryNodes.id, nodeId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    listNodesByKind: (companyId: string, agentId: string, kind: AgentMemoryNodeKind) =>
      db
        .select()
        .from(agentMemoryNodes)
        .where(
          and(
            eq(agentMemoryNodes.companyId, companyId),
            eq(agentMemoryNodes.agentId, agentId),
            eq(agentMemoryNodes.kind, kind),
          ),
        ),
  };
}

async function upsertNode(db: Db, input: UpsertMemoryNodeInput) {
  const kind = assertMemoryNodeKind(input.kind);
  const set: Record<string, unknown> = {
    content: input.content,
    updatedAt: new Date(),
  };
  if (input.metadata !== undefined) set.metadata = input.metadata;
  if (input.sourceRunId !== undefined) set.sourceRunId = input.sourceRunId;
  const [node] = await db
    .insert(agentMemoryNodes)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      kind,
      label: input.label,
      content: input.content,
      metadata: input.metadata ?? {},
      sourceRunId: input.sourceRunId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        agentMemoryNodes.companyId,
        agentMemoryNodes.agentId,
        agentMemoryNodes.kind,
        agentMemoryNodes.label,
      ],
      set,
    })
    .returning();
  return node;
}

async function createEdge(db: Db, input: CreateMemoryEdgeInput) {
  const [edge] = await db
    .insert(agentMemoryEdges)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      relation: input.relation,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({
      target: [
        agentMemoryEdges.fromNodeId,
        agentMemoryEdges.toNodeId,
        agentMemoryEdges.relation,
      ],
    })
    .returning();
  // onConflictDoNothing returns nothing on conflict — fetch the existing edge
  // so callers always get the canonical row back (idempotent create).
  if (edge) return edge;
  const rows = await db
    .select()
    .from(agentMemoryEdges)
    .where(
      and(
        eq(agentMemoryEdges.companyId, input.companyId),
        eq(agentMemoryEdges.agentId, input.agentId),
        eq(agentMemoryEdges.fromNodeId, input.fromNodeId),
        eq(agentMemoryEdges.toNodeId, input.toNodeId),
        eq(agentMemoryEdges.relation, input.relation),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// Re-exported for callers that need to bulk-resolve nodes by id within an
// agent's scope (kept here so the isolation predicate stays centralized).
export async function getMemoryNodesByIds(
  db: Db,
  companyId: string,
  agentId: string,
  nodeIds: string[],
) {
  if (nodeIds.length === 0) return [];
  return db
    .select()
    .from(agentMemoryNodes)
    .where(
      and(
        eq(agentMemoryNodes.companyId, companyId),
        eq(agentMemoryNodes.agentId, agentId),
        inArray(agentMemoryNodes.id, nodeIds),
      ),
    );
}
