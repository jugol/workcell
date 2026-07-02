-- WC-171: heartbeat_run_events.run_id had a plain (non-cascading) FK to
-- heartbeat_runs, so agentService.remove() purged a deleted agent's run events
-- before deleting its runs. That purge races the live run executor: an event
-- written into an in-flight run AFTER the purge but BEFORE the heartbeat_runs
-- delete made the run delete fail with an FK violation, rolling back the whole
-- agent removal — so an agent became un-deletable while it had an executing run.
-- Cascade the run_id FK so deleting a run atomically removes its events, closing
-- the race. Run events are ephemeral run telemetry owned by the run.
ALTER TABLE "heartbeat_run_events" DROP CONSTRAINT IF EXISTS "heartbeat_run_events_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade;
