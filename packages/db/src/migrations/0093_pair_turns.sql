-- WC-25 (P2 §3 third slice): PairTurn ledger.
CREATE TABLE "pair_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "pair_group_id" uuid NOT NULL,
  "round" integer NOT NULL,
  "actor_agent_id" uuid,
  "run_id" uuid,
  "summary" text,
  "outcome" text DEFAULT 'delivered' NOT NULL,
  "cost_cents" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pair_turns" ADD CONSTRAINT "pair_turns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
--> statement-breakpoint
ALTER TABLE "pair_turns" ADD CONSTRAINT "pair_turns_pair_group_id_pair_groups_id_fk" FOREIGN KEY ("pair_group_id") REFERENCES "public"."pair_groups"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "pair_turns" ADD CONSTRAINT "pair_turns_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id");
--> statement-breakpoint
ALTER TABLE "pair_turns" ADD CONSTRAINT "pair_turns_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "pair_turns_group_idx" ON "pair_turns" ("pair_group_id", "round");
--> statement-breakpoint
CREATE INDEX "pair_turns_company_idx" ON "pair_turns" ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pair_turns_actor_unique_per_round" ON "pair_turns" ("pair_group_id", "round", "actor_agent_id");
