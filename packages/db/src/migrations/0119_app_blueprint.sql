-- "디자인 시스템" → "전체 앱 기획" redesign foundation (additive, no behavior change).
--
-- (1) issue_work_products gains plan_markdown: the "화면 기획" (screen plan) spec
--     body. Carried by the new non-design 'screen_plan' work-product type, paired
--     to its pure-screen 시안 by the same canonical screen_key. Nullable — design
--     mockups and legacy rows leave it NULL.
ALTER TABLE "issue_work_products" ADD COLUMN "plan_markdown" text;--> statement-breakpoint

-- (2) design_screen_positions: persisted per-screen positions for the flow canvas
--     (R5 drag-to-reposition). Keyed by the STABLE canonical screen_key (NOT a
--     work-product id, which is version-volatile), scoped to a project (project_id
--     NULL = company-level default app), mirroring design_screen_links. Shared per
--     app-scope. Absent rows fall back to auto-layout.
CREATE TABLE "design_screen_positions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "project_id" uuid REFERENCES "projects"("id") ON DELETE set null,
  "screen_key" text NOT NULL,
  "x" double precision NOT NULL,
  "y" double precision NOT NULL,
  "updated_by_kind" text,
  "updated_by_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "design_screen_positions_company_project_idx" ON "design_screen_positions" ("company_id","project_id");--> statement-breakpoint
-- NULLS NOT DISTINCT so company-level (project_id NULL) positions still dedupe (PG15+).
CREATE UNIQUE INDEX "design_screen_positions_unique" ON "design_screen_positions" ("company_id","project_id","screen_key") NULLS NOT DISTINCT;
