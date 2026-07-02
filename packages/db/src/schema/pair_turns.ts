import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { pairGroups } from "./pair_groups.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// WC-25 (P2 §3 third slice): PairTurn — one entry per (group, round, actor).
// Records what an agent contributed in a given pair round: the artifact or
// summary they produced, the cost, whether they signaled convergence or
// abort. The advancement logic uses these rows to decide when to bump the
// group's currentRound and when to trigger stop policy.
//
// Outcome semantics:
//   - "delivered" — actor produced an artifact; round can advance.
//   - "no_change" — actor passed without contributing (e.g. counterpart
//                   says "your output looks good"); used in convergence
//                   detection.
//   - "abort" — actor signaled the group should stop entirely.
//
// A (groupId, round, actorAgentId) tuple is unique — an agent contributes
// once per round.
export const pairTurns = pgTable(
  "pair_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    pairGroupId: uuid("pair_group_id").notNull().references(() => pairGroups.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    // Which seat produced this turn ("owner" | "counterpart"). Lane — not
    // actorAgentId — is the identity of a side: in a dual_brain group both
    // lanes are the SAME agent. Nullable only for pre-0117 rows that predate
    // the column (the migration backfills them).
    lane: text("lane"),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    // Free-form summary the actor produced. Could be a draft, a critique, a
    // proposed change. Storage stays cheap so this is plain text; rich
    // artifacts live in issue_work_products and are linked via the run id.
    summary: text("summary"),
    // Outcome enum — see header comment.
    outcome: text("outcome").notNull().default("delivered"),
    costCents: integer("cost_cents").notNull().default(0),
    // Free-form metadata bag for orchestration-specific fields (tokens,
    // model, diff stats, …). Keep the schema flexible so each future round
    // engine can stamp what it needs without another column.
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pair_turns_group_idx").on(table.pairGroupId, table.round),
    index("pair_turns_company_idx").on(table.companyId),
    // Each LANE contributes once per round per group (was actor-keyed before
    // 0117 — actor uniqueness breaks dual_brain, where one agent fills both
    // lanes in the same round).
    uniqueIndex("pair_turns_lane_unique_per_round").on(table.pairGroupId, table.round, table.lane),
  ],
);

export type PairTurnOutcome = "delivered" | "no_change" | "abort";
