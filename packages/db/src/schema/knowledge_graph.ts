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

// WC-28 (D12 first slice): minimal Knowledge Graph PoC.
//
// Per D12 spec: nodes are *pointers* to existing entities (issue, code
// path, plan section, decision). Edges are typed relationships. Body
// content is NEVER duplicated here — node.entityRef points at the
// canonical source. The graph is a *navigation index*, not a content store.
//
// Why Postgres-native tables (no AGE / pgvector at this stage):
//   - Keeps the substrate dep-free; AGE adds a heavy extension that
//     greenfield deployments may not have.
//   - The first PoC workload is bounded (≤ a few thousand nodes per
//     company) and pure SQL traversal is fast enough.
//   - AGE-style graph queries can be layered on later behind the same
//     service interface if traversal needs become non-trivial.
export const graphNodes = pgTable(
  "graph_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Open enum so future node kinds (decision/run/skill/plugin) can be
    // added without schema churn. Validated at the service layer.
    nodeKind: text("node_kind").notNull(),
    // Logical reference to the underlying entity. For "issue" this is the
    // issue id; for "code" the file path; for "plan_section" the heading
    // anchor. The service composes (nodeKind, entityRef) into a unique
    // graph identity.
    entityRef: text("entity_ref").notNull(),
    label: text("label").notNull(),
    // Free-form metadata bag — line ranges, plan section headings,
    // weights, etc. Kept open so each node kind can stamp what it needs.
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("graph_nodes_company_idx").on(table.companyId),
    index("graph_nodes_kind_idx").on(table.companyId, table.nodeKind),
    // A given (kind, ref) is one node per company.
    uniqueIndex("graph_nodes_kind_ref_unique").on(table.companyId, table.nodeKind, table.entityRef),
  ],
);

export const graphEdges = pgTable(
  "graph_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    fromNodeId: uuid("from_node_id").notNull().references(() => graphNodes.id, { onDelete: "cascade" }),
    toNodeId: uuid("to_node_id").notNull().references(() => graphNodes.id, { onDelete: "cascade" }),
    // Open enum (e.g. "implements" | "depends_on" | "references" |
    // "spawned_by" | "supersedes"). Validated at the service layer.
    edgeKind: text("edge_kind").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("graph_edges_company_idx").on(table.companyId),
    index("graph_edges_from_idx").on(table.fromNodeId),
    index("graph_edges_to_idx").on(table.toNodeId),
    // A given typed edge between two nodes is unique — re-registering the
    // same (from, to, kind) tuple is a no-op.
    uniqueIndex("graph_edges_triple_unique").on(table.fromNodeId, table.toNodeId, table.edgeKind),
  ],
);
