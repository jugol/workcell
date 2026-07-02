import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// WC-181 (slice 1): per-agent memory graph.
//
// Unlike the company-scoped Knowledge Graph (graph_nodes/graph_edges,
// knowledge_graph.ts) which is a *pointer index* keyed by companyId — these
// tables are AGENT-scoped and STORE CONTENT. A node carries the actual
// remembered text in `content`; an agent recalls its own facts/preferences/
// decisions directly from here rather than dereferencing a pointer to some
// canonical source. Every row is tenant- AND agent-isolated: queries filter on
// BOTH companyId and agentId.
//
// Cascade design (see docs/solutions/delete-path-fk-completeness.md):
//   - companyId / agentId FKs use ON DELETE CASCADE. These tables are *owned*
//     by the agent (and transitively the company): an agent's memories are
//     meaningless once the agent is gone, so cascade is the correct ownership
//     model. Critically, CASCADE also closes the FK-race class (WC-171): the
//     agent-removal path (agentService.remove) writes/deletes many child rows
//     in one transaction; a static "purge agent_memory before deleting agent"
//     step would be both unnecessary churn AND race-prone against any
//     concurrent writer. With CASCADE the DB removes these rows atomically with
//     the agent delete — no purge↔delete window, no 23503.
//   - edges' fromNodeId / toNodeId FKs CASCADE on the owning nodes, so deleting
//     a node atomically removes the edges incident to it.
//   - sourceRunId is provenance only (which heartbeat run remembered this) and
//     uses ON DELETE SET NULL: a run is ephemeral telemetry whose deletion must
//     not erase the remembered fact, only drop the dead pointer (mirrors the
//     WC-174 audit-pointer discipline). SET NULL is blast-radius 0.
export const agentMemoryNodes = pgTable(
  "agent_memory_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // Open enum so future memory kinds can be added without schema churn.
    // Validated at the service layer:
    //   "fact" | "preference" | "entity" | "decision" | "todo" | "other".
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    // The actual remembered text. This is what makes agent_memory a content
    // store — the KG, by contrast, only stores a pointer (entityRef).
    content: text("content").notNull(),
    // Free-form metadata bag (tags, confidence, source url, etc.). Kept open
    // so each kind can stamp what it needs.
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    // Provenance: the heartbeat run that produced/last-touched this memory.
    // SET NULL on run delete — the memory outlives the ephemeral run.
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_memory_nodes_company_agent_idx").on(table.companyId, table.agentId),
    index("agent_memory_nodes_company_agent_kind_idx").on(
      table.companyId,
      table.agentId,
      table.kind,
    ),
    // Idempotent upsert key: a given (kind, label) is one node per agent, so
    // re-remembering the same labelled fact updates in place instead of
    // duplicating. Tenant + agent scoped.
    uniqueIndex("agent_memory_nodes_company_agent_kind_label_unique").on(
      table.companyId,
      table.agentId,
      table.kind,
      table.label,
    ),
  ],
);

export const agentMemoryEdges = pgTable(
  "agent_memory_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    fromNodeId: uuid("from_node_id")
      .notNull()
      .references(() => agentMemoryNodes.id, { onDelete: "cascade" }),
    toNodeId: uuid("to_node_id")
      .notNull()
      .references(() => agentMemoryNodes.id, { onDelete: "cascade" }),
    // Open enum (e.g. "relates_to" | "depends_on" | "supersedes" | "about").
    // Validated at the service layer.
    relation: text("relation").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_memory_edges_from_idx").on(table.fromNodeId),
    index("agent_memory_edges_to_idx").on(table.toNodeId),
    // A given typed edge between two nodes is unique — re-registering the same
    // (from, to, relation) tuple is a no-op.
    uniqueIndex("agent_memory_edges_triple_unique").on(
      table.fromNodeId,
      table.toNodeId,
      table.relation,
    ),
  ],
);
