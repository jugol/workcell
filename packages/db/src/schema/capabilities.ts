import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// WC-27 (PLAN §9 #7 first slice): Capability Registry.
//
// Capabilities are reusable units of agent skill/tool/integration — e.g. an
// MCP server connection, a skill bundle, a plugin contribution. The
// registry tracks the manifest (what does it do, where does it come from,
// what's its trust tier) separately from assignments (which company/agent
// has access to which capability at what visibility).
//
// Two tables:
//   - capabilities: the manifest. Versioned via `version` field; new
//     versions get a new row so assignments can pin if needed.
//   - capability_assignments: scope record. company-scoped by default;
//     agent_id optional to narrow to a specific agent.
//
// trustTier values aligned with D15: "trusted" | "reviewed" | "unreviewed".
// Source kind reuses the same vocabulary as company_skills sources where
// it overlaps (plugin / mcp / skill_bundle / builtin).
export const capabilities = pgTable(
  "capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Stable identifier within a company (e.g. "anthropic/claude-mcp").
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sourceKind: text("source_kind").notNull(),
    sourceLocator: text("source_locator"),
    version: text("version").notNull().default("1.0.0"),
    trustTier: text("trust_tier").notNull().default("unreviewed"),
    // Free-form metadata bag (capability-specific fields like supported
    // tools, model preferences, etc.).
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("capabilities_company_idx").on(table.companyId),
    // A given key+version is unique per company.
    uniqueIndex("capabilities_company_key_version_unique").on(table.companyId, table.key, table.version),
  ],
);

// Assignment statuses determine whether the assignment is currently in
// effect:
//   - "active": the agent can use it.
//   - "pending_approval": user-triggered installation hasn't been confirmed
//     by an approver yet (typical for trustTier != "trusted" capabilities).
//   - "revoked": access was removed; record kept for audit.
//
// Visibility distinguishes how the capability is surfaced to the agent
// (D17 spec). "default" = standard listing. "hidden" = present but not
// shown to the agent unless explicitly summoned. "deprecated" = phasing
// out; surfaced with a warning.
export const capabilityAssignments = pgTable(
  "capability_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    capabilityId: uuid("capability_id").notNull().references(() => capabilities.id, { onDelete: "cascade" }),
    // Null agentId = company-wide assignment.
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    visibility: text("visibility").notNull().default("default"),
    grantedByUserId: text("granted_by_user_id"),
    grantedByAgentId: uuid("granted_by_agent_id").references(() => agents.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("capability_assignments_company_idx").on(table.companyId),
    index("capability_assignments_capability_idx").on(table.capabilityId),
    index("capability_assignments_agent_idx").on(table.agentId),
    // A given capability is assigned at most once per (company, agent)
    // tuple. WC-53: .nullsNotDistinct() so company-wide rows (agent_id IS
    // NULL) are treated as EQUAL by Postgres rather than as distinct nulls —
    // without it the unique constraint enforces nothing for company-wide
    // assignments and two concurrent assign() calls both insert duplicates.
    // Uses a UNIQUE CONSTRAINT (not uniqueIndex) because nullsNotDistinct()
    // is only exposed on the constraint builder. Same pattern as
    // plugin_state.ts. Requires PostgreSQL 15+.
    unique("capability_assignments_scope_unique")
      .on(table.companyId, table.capabilityId, table.agentId)
      .nullsNotDistinct(),
  ],
);
