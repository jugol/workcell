-- WC-174: close the agent/run-delete race on activity_log (sibling of WC-171).
--
-- activity_log.run_id and .agent_id were plain (RESTRICT) FKs, so agentService/
-- companyService.remove() had to purge a deleted entity's audit rows before
-- deleting its runs/agent. That purge races the live run executor: an
-- activity_log row written into an in-flight run AFTER the purge but BEFORE the
-- run/agent delete re-introduces a referencing row, the delete fails with FK
-- 23503, and the whole removal rolls back (the entity becomes un-deletable while
-- a run is live).
--
-- Fix: make both FKs ON DELETE SET NULL so a run/agent delete nulls the dead
-- pointer instead of blocking — preserving the audit row (company_id + content
-- intact). Cascade would be wrong (it would delete audit history). SET NULL on
-- activity_log fires an UPDATE, which the WC-29/0101 append-only trigger blocks,
-- so the trigger is extended to permit EXACTLY this FK-driven null-ing: an UPDATE
-- that only sets run_id and/or agent_id to NULL with every other column
-- unchanged. All other UPDATEs (and ad-hoc DELETEs) stay rejected, so append-only
-- is preserved for live audit history.
CREATE OR REPLACE FUNCTION activity_log_block_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('workcell.allow_activity_log_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.agent_id IS DISTINCT FROM OLD.agent_id)
     AND (NEW.run_id IS NULL OR NEW.run_id = OLD.run_id)
     AND (NEW.agent_id IS NULL OR NEW.agent_id = OLD.agent_id)
     AND NEW.id = OLD.id
     AND NEW.company_id = OLD.company_id
     AND NEW.actor_type = OLD.actor_type
     AND NEW.actor_id = OLD.actor_id
     AND NEW.action = OLD.action
     AND NEW.entity_type = OLD.entity_type
     AND NEW.entity_id = OLD.entity_id
     AND NEW.details IS NOT DISTINCT FROM OLD.details
     AND NEW.created_at = OLD.created_at
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'activity_log is append-only — % on row id=% rejected', TG_OP, OLD.id
    USING ERRCODE = 'feature_not_supported';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
ALTER TABLE "activity_log" DROP CONSTRAINT IF EXISTS "activity_log_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "activity_log" DROP CONSTRAINT IF EXISTS "activity_log_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;
