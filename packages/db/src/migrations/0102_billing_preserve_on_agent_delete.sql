-- WC-137: preserve a company's billing history when an agent (and its runs) is
-- hard-deleted. Previously cost_events.agent_id was NOT NULL with a plain FK, so
-- agentService.remove() had to PURGE the agent's cost/finance rows — which made a
-- company's historical spend shrink whenever an agent was deleted (a financial-
-- integrity bug: the company still paid that money). Now agent_id is nullable and
-- both the agent_id and heartbeat_run_id FKs SET NULL on delete, so the billing
-- rows survive with company_id + cost_cents/amount_cents intact — consistent with
-- the billing-preservation discipline of issue/project/goal removal (WC-134/135),
-- where billing links are nulled rather than the financial rows deleted.
ALTER TABLE "cost_events" ALTER COLUMN "agent_id" DROP NOT NULL;

ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_agent_id_agents_id_fk";
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;

ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_heartbeat_run_id_heartbeat_runs_id_fk";
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null;

ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_agent_id_agents_id_fk";
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;

ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_heartbeat_run_id_heartbeat_runs_id_fk";
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null;
