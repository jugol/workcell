-- Design-system redesign — screens become first-class.
--
-- (1) issue_work_products gains SCREEN IDENTITY so ONE issue can hold MULTIPLE
--     design artifacts (one screen per artifact, R2/R5). screen_key is a stable
--     slug identifying a canonical app page within a project (company-level
--     fallback when the issue has no project); screen_name is its display label.
--     Both are nullable for back-compat — legacy rows fall back to title-lineage
--     grouping at the service layer (effectiveScreenKey = screen_key ?? lineage).
ALTER TABLE "issue_work_products" ADD COLUMN "screen_key" text;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "screen_name" text;--> statement-breakpoint

-- (2) design_screen_links: explicit screen→screen NAVIGATION edges (R3). A link
--     means "an element on the FROM screen navigates to the TO screen". Scoped to
--     a project (project_id NULL = company-level default app). Declared by the
--     designer agent at attach time and editable by the board in the flow
--     dashboard. source_work_product_id remembers which 시안 declared it (best
--     effort; set null on delete). created_by_kind = 'agent' | 'board'.
CREATE TABLE "design_screen_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "project_id" uuid REFERENCES "projects"("id") ON DELETE set null,
  "from_screen_key" text NOT NULL,
  "to_screen_key" text NOT NULL,
  "label" text NOT NULL DEFAULT '',
  "source_work_product_id" uuid REFERENCES "issue_work_products"("id") ON DELETE set null,
  "created_by_kind" text NOT NULL DEFAULT 'agent',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "design_screen_links_company_project_idx" ON "design_screen_links" ("company_id","project_id");--> statement-breakpoint
-- NULLS NOT DISTINCT so company-level (project_id NULL) links still dedupe (PG15+).
CREATE UNIQUE INDEX "design_screen_links_unique" ON "design_screen_links" ("company_id","project_id","from_screen_key","to_screen_key","label") NULLS NOT DISTINCT;--> statement-breakpoint

-- (3) design_guides: the single canonical "design system guide" page per app
--     (R1). project_id NULL = company-level default app. notes_markdown is the
--     board-authored memo layered over auto-extracted tokens (tokens are derived
--     on read from approved screens, not stored here). One guide per (company,
--     project).
CREATE TABLE "design_guides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "project_id" uuid REFERENCES "projects"("id") ON DELETE cascade,
  "notes_markdown" text NOT NULL DEFAULT '',
  "updated_by_kind" text,
  "updated_by_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "design_guides_company_project_unique" ON "design_guides" ("company_id","project_id") NULLS NOT DISTINCT;
