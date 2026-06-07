-- WC-24 (P2 §3 second slice): PairGroup entity + Issue.pairGroupId back-reference.
CREATE TABLE "pair_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "owner_agent_id" uuid,
  "counterpart_agent_id" uuid,
  "current_round" integer DEFAULT 0 NOT NULL,
  "max_rounds" integer DEFAULT 10 NOT NULL,
  "stop_policy" jsonb,
  "status" text DEFAULT 'active' NOT NULL,
  "stop_reason" text,
  "total_cost_cents" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pair_groups" ADD CONSTRAINT "pair_groups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
--> statement-breakpoint
ALTER TABLE "pair_groups" ADD CONSTRAINT "pair_groups_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id");
--> statement-breakpoint
ALTER TABLE "pair_groups" ADD CONSTRAINT "pair_groups_counterpart_agent_id_agents_id_fk" FOREIGN KEY ("counterpart_agent_id") REFERENCES "public"."agents"("id");
--> statement-breakpoint
CREATE INDEX "pair_groups_company_idx" ON "pair_groups" ("company_id");
--> statement-breakpoint
CREATE INDEX "pair_groups_issue_idx" ON "pair_groups" ("issue_id");
--> statement-breakpoint
CREATE INDEX "pair_groups_status_idx" ON "pair_groups" ("company_id", "status");
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "pair_group_id" uuid;
