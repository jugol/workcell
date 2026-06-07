-- WC-175: agent_task_sessions.last_run_id was a plain (RESTRICT) FK to
-- heartbeat_runs — the last heartbeat_runs child in the agent-removal path that
-- could FK-block the run delete via the purge-vs-live-writer race (sibling of
-- WC-171 / WC-174). SET NULL so deleting a run nulls this informational pointer
-- instead of blocking. No append-only trigger on this table, so no trigger change.
ALTER TABLE "agent_task_sessions" DROP CONSTRAINT IF EXISTS "agent_task_sessions_last_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null;
