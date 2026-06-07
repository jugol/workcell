-- WC-209 (deliberation async + persist): two tables backing async dual-brain
-- deliberation runs. The header row (agent_deliberation_runs) tracks one run's
-- lifecycle (running → completed/failed) + snapshotted brain configs + summed
-- cost; agent_deliberation_turns stores each transcript entry as it is produced
-- so a polling GET sees turns stream in incrementally. company_id / agent_id /
-- run_id all cascade (these rows are owned by the agent / run).
CREATE TABLE "agent_deliberation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "task" text,
  "status" text DEFAULT 'running' NOT NULL,
  "accepted_by" text,
  "rounds" integer DEFAULT 0,
  "final_output" text,
  "total_cost_cents" integer DEFAULT 0,
  "error" text,
  "max_rounds" integer,
  "brain_a" jsonb,
  "brain_b" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_deliberation_runs" ADD CONSTRAINT "agent_deliberation_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "agent_deliberation_runs" ADD CONSTRAINT "agent_deliberation_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "agent_deliberation_runs_company_agent_idx" ON "agent_deliberation_runs" ("company_id", "agent_id");
--> statement-breakpoint
CREATE TABLE "agent_deliberation_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "round" integer,
  "brain" text,
  "action" text,
  "content" text,
  "feedback" text,
  "cost_cents" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_deliberation_turns" ADD CONSTRAINT "agent_deliberation_turns_run_id_agent_deliberation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_deliberation_runs"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "agent_deliberation_turns_run_idx" ON "agent_deliberation_turns" ("run_id");
