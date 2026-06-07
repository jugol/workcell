import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { agentDeliberationRuns } from "./agent_deliberation_runs.js";

// WC-209 (deliberation async + persist): one row per transcript entry of an
// async deliberation run. The WC-204 engine pushes a transcript entry for the
// initial propose and for each accept/revise; an `onTurn` callback persists
// each entry HERE the moment it is produced, so a GET that polls mid-run sees
// turns stream in incrementally (instead of nothing until the whole ~5 min run
// finishes). run_id cascades — turns die with their run.
//
// Mirrors DeliberationTranscriptEntry: { round, brain, action, content,
// feedback } plus the per-turn billed cost (cost_cents), summed into the run's
// total_cost_cents as turns land.
export const agentDeliberationTurns = pgTable(
  "agent_deliberation_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentDeliberationRuns.id, { onDelete: "cascade" }),
    // 0 for the initial propose; increments by 1 per review turn.
    round: integer("round"),
    // "A" | "B" — which brain produced this entry.
    brain: text("brain"),
    // "propose" | "accept" | "revise".
    action: text("action"),
    // The proposal / revision text for this entry.
    content: text("content"),
    // Reviewer feedback (revise turns only; null otherwise).
    feedback: text("feedback"),
    // Billed cents for this turn (0 for the stub / when no cost reported).
    costCents: integer("cost_cents").default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Turns are always fetched by run, ordered (round asc, createdAt asc).
    index("agent_deliberation_turns_run_idx").on(table.runId),
  ],
);
