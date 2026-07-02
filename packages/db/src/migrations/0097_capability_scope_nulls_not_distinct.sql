-- WC-53: make the capability_assignments scope-unique guard treat NULL
-- agent_id (company-wide assignments) as equal, so duplicates are blocked
-- at the DB layer. The original 0094 index used default NULL-distinct
-- semantics, which enforced nothing for company-wide rows. Replace the
-- index with a UNIQUE CONSTRAINT using NULLS NOT DISTINCT (PostgreSQL 15+).
DROP INDEX IF EXISTS "capability_assignments_scope_unique";
--> statement-breakpoint
ALTER TABLE "capability_assignments"
  ADD CONSTRAINT "capability_assignments_scope_unique"
  UNIQUE NULLS NOT DISTINCT ("company_id", "capability_id", "agent_id");
