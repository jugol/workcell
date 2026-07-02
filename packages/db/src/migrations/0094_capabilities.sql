-- WC-27 (PLAN §9 #7 first slice): Capability Registry.
CREATE TABLE "capabilities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "source_kind" text NOT NULL,
  "source_locator" text,
  "version" text DEFAULT '1.0.0' NOT NULL,
  "trust_tier" text DEFAULT 'unreviewed' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
--> statement-breakpoint
CREATE INDEX "capabilities_company_idx" ON "capabilities" ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "capabilities_company_key_version_unique" ON "capabilities" ("company_id", "key", "version");
--> statement-breakpoint
CREATE TABLE "capability_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "capability_id" uuid NOT NULL,
  "agent_id" uuid,
  "status" text DEFAULT 'active' NOT NULL,
  "visibility" text DEFAULT 'default' NOT NULL,
  "granted_by_user_id" text,
  "granted_by_agent_id" uuid,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "capability_assignments" ADD CONSTRAINT "capability_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");
--> statement-breakpoint
ALTER TABLE "capability_assignments" ADD CONSTRAINT "capability_assignments_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "capability_assignments" ADD CONSTRAINT "capability_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "capability_assignments" ADD CONSTRAINT "capability_assignments_granted_by_agent_id_agents_id_fk" FOREIGN KEY ("granted_by_agent_id") REFERENCES "public"."agents"("id");
--> statement-breakpoint
CREATE INDEX "capability_assignments_company_idx" ON "capability_assignments" ("company_id");
--> statement-breakpoint
CREATE INDEX "capability_assignments_capability_idx" ON "capability_assignments" ("capability_id");
--> statement-breakpoint
CREATE INDEX "capability_assignments_agent_idx" ON "capability_assignments" ("agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "capability_assignments_scope_unique" ON "capability_assignments" ("company_id", "capability_id", "agent_id");
