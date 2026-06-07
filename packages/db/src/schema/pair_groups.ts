import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// WC-24 (P2 §3 second slice): PairGroup — a unit of pair collaboration on
// an issue. Two or more agents work together on the same task across
// multiple rounds; the group tracks the participants, the stop policy
// (max rounds, abort reasons), and aggregate state (current round,
// status, last activity).
//
// The actual round work lives in PairTurn rows (later slice) — one per
// round-x-participant tuple. This table is the lightweight group header.
//
// Status lifecycle:
//   - "active" — work is in progress (current round may still be advancing)
//   - "completed" — stop reason reached; the group reached the agreed exit
//   - "aborted" — stop reason was a failure mode (e.g. max-rounds reached
//                without convergence, hard error, user cancellation)
export const pairGroups = pgTable(
  "pair_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // The issue this pair group is working on. Required at create time so
    // the group always has a target. (When the slice ships orchestration,
    // Issue.pairGroupId provides the back-reference so the lookup is fast
    // in both directions.)
    issueId: uuid("issue_id").notNull(),
    // The agent that initiated/owns the pair (typically a Planner/PM role).
    // The other participants live in pair_group_participants (later slice
    // when we need more than two — for the first version a single ownerAgent
    // + a single counterpart is enough).
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id),
    counterpartAgentId: uuid("counterpart_agent_id").references(() => agents.id),
    // Round counters. Spec calls for max 10 rounds with a stop policy; the
    // policy itself is recorded as JSON for flexibility (max rounds, abort
    // reasons, success criteria).
    currentRound: integer("current_round").notNull().default(0),
    maxRounds: integer("max_rounds").notNull().default(10),
    stopPolicy: jsonb("stop_policy").$type<{
      maxRounds?: number;
      abortOn?: string[];
      requireConvergence?: boolean;
    } | null>().default(null),
    // Group status.
    status: text("status").notNull().default("active"),
    // Free-form stop reason captured when status transitions to
    // completed/aborted. Examples: "agreed_on_solution", "max_rounds_reached",
    // "executor_aborted", "user_cancelled".
    stopReason: text("stop_reason"),
    // Aggregate cost so far in cents. Updated as PairTurn rows are recorded
    // (future slice). Default 0 keeps the column NOT NULL.
    totalCostCents: integer("total_cost_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    // Most common lookups: by issue, by status within a company.
    index("pair_groups_company_idx").on(table.companyId),
    index("pair_groups_issue_idx").on(table.issueId),
    index("pair_groups_status_idx").on(table.companyId, table.status),
  ],
);
