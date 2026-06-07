-- WC-28 (D12 first slice): Knowledge Graph PoC.
CREATE TABLE "graph_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "node_kind" text NOT NULL,
  "entity_ref" text NOT NULL,
  "label" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
--> statement-breakpoint
CREATE INDEX "graph_nodes_company_idx" ON "graph_nodes" ("company_id");
--> statement-breakpoint
CREATE INDEX "graph_nodes_kind_idx" ON "graph_nodes" ("company_id", "node_kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "graph_nodes_kind_ref_unique" ON "graph_nodes" ("company_id", "node_kind", "entity_ref");
--> statement-breakpoint
CREATE TABLE "graph_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "from_node_id" uuid NOT NULL,
  "to_node_id" uuid NOT NULL,
  "edge_kind" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_from_node_id_graph_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_to_node_id_graph_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "graph_edges_company_idx" ON "graph_edges" ("company_id");
--> statement-breakpoint
CREATE INDEX "graph_edges_from_idx" ON "graph_edges" ("from_node_id");
--> statement-breakpoint
CREATE INDEX "graph_edges_to_idx" ON "graph_edges" ("to_node_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "graph_edges_triple_unique" ON "graph_edges" ("from_node_id", "to_node_id", "edge_kind");
