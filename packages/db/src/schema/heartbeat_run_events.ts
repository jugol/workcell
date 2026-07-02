import { pgTable, uuid, text, timestamp, integer, jsonb, index, bigserial } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const heartbeatRunEvents = pgTable(
  "heartbeat_run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // WC-171: cascade so a run's events are removed atomically when the run is
    // deleted. The agent-removal path purges these events before deleting the
    // runs, but that purge races the live run executor (an event written into an
    // in-flight run after the purge, before the run delete, used to fail the run
    // delete with an FK violation and roll back the whole agent removal). Run
    // events are ephemeral run telemetry owned by the run, so cascade is correct.
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    seq: integer("seq").notNull(),
    eventType: text("event_type").notNull(),
    stream: text("stream"),
    level: text("level"),
    color: text("color"),
    message: text("message"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSeqIdx: index("heartbeat_run_events_run_seq_idx").on(table.runId, table.seq),
    companyRunIdx: index("heartbeat_run_events_company_run_idx").on(table.companyId, table.runId),
    companyCreatedIdx: index("heartbeat_run_events_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

