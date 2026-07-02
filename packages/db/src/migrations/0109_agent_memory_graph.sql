-- WC-181 (slice 1): per-agent memory graph. Agent-scoped, content-storing
-- tables (unlike the company-scoped pointer-only knowledge graph). company_id
-- and agent_id cascade (these rows are owned by the agent — cascade also closes
-- the FK-race class on agent removal, WC-171); source_run_id SET NULL keeps a
-- remembered fact alive when its provenance run is deleted (WC-174 discipline).
CREATE TABLE "agent_memory_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "content" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "source_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_memory_nodes" ADD CONSTRAINT "agent_memory_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "agent_memory_nodes" ADD CONSTRAINT "agent_memory_nodes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "agent_memory_nodes" ADD CONSTRAINT "agent_memory_nodes_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "agent_memory_nodes_company_agent_idx" ON "agent_memory_nodes" ("company_id", "agent_id");
--> statement-breakpoint
CREATE INDEX "agent_memory_nodes_company_agent_kind_idx" ON "agent_memory_nodes" ("company_id", "agent_id", "kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_nodes_company_agent_kind_label_unique" ON "agent_memory_nodes" ("company_id", "agent_id", "kind", "label");
--> statement-breakpoint
CREATE TABLE "agent_memory_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "from_node_id" uuid NOT NULL,
  "to_node_id" uuid NOT NULL,
  "relation" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_memory_edges" ADD CONSTRAINT "agent_memory_edges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "agent_memory_edges" ADD CONSTRAINT "agent_memory_edges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "agent_memory_edges" ADD CONSTRAINT "agent_memory_edges_from_node_id_agent_memory_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."agent_memory_nodes"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "agent_memory_edges" ADD CONSTRAINT "agent_memory_edges_to_node_id_agent_memory_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."agent_memory_nodes"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "agent_memory_edges_from_idx" ON "agent_memory_edges" ("from_node_id");
--> statement-breakpoint
CREATE INDEX "agent_memory_edges_to_idx" ON "agent_memory_edges" ("to_node_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_edges_triple_unique" ON "agent_memory_edges" ("from_node_id", "to_node_id", "relation");
