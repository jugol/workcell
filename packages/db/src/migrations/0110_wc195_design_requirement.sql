ALTER TABLE "issues" ADD COLUMN "design_requirement" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "require_design_first" boolean DEFAULT false NOT NULL;
