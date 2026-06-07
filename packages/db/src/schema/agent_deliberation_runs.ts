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

// WC-209 (deliberation async + persist): the header row for one async
// dual-brain deliberation run. The synchronous POST /agents/:id/deliberate
// used to block ~5 min per run (each claude_local turn ~75s) and the transcript
// only lived in the HTTP response — lost on timeout, after spending real money.
//
// Now the POST inserts ONE of these rows (status "running") and kicks off the
// WC-204 consensus engine fire-and-forget; GET routes poll this table (+ the
// per-turn agent_deliberation_turns rows) until status flips to "completed" or
// "failed". The brain configs actually used are snapshotted (brainA/brainB) so
// the run is self-describing even if the agent's config later changes.
//
// company_id / agent_id cascade — these rows are owned by the agent and should
// disappear with it.
//
// NOTE (v1 limitation): a server restart mid-run leaves a row stuck "running"
// (the fire-and-forget loop dies with the process). Acceptable for v1; a reaper
// that fails orphaned "running" rows on boot is a follow-up.
export const agentDeliberationRuns = pgTable(
  "agent_deliberation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // The deliberation task prompt the run was started with.
    task: text("task"),
    // Lifecycle: "running" (in flight) | "completed" (engine returned) |
    // "failed" (engine threw — see `error`).
    status: text("status").notNull().default("running"),
    // Which brain ACCEPTed the final proposal ("A" | "B"), or null when the run
    // hit maxRounds without an accept (latest proposal wins).
    acceptedBy: text("accepted_by"),
    // Number of review rounds the engine ran.
    rounds: integer("rounds").default(0),
    // The agreed final output (set on completion).
    finalOutput: text("final_output"),
    // Sum of each turn's billed cents (accumulated as turns persist).
    totalCostCents: integer("total_cost_cents").default(0),
    // Failure detail when status === "failed".
    error: text("error"),
    // The effective maxRounds the run used (override or the agent's config).
    maxRounds: integer("max_rounds"),
    // Snapshot of the brain configs used for THIS run (adapter + model), so the
    // run stays self-describing if the agent's deliberation config later changes.
    brainA: jsonb("brain_a").$type<{ adapter?: string | null; model?: string | null } | null>(),
    brainB: jsonb("brain_b").$type<{ adapter?: string | null; model?: string | null } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    // Most common lookup: recent runs for an agent within a company.
    index("agent_deliberation_runs_company_agent_idx").on(table.companyId, table.agentId),
  ],
);

export type AgentDeliberationRunStatus = "running" | "completed" | "failed";
