-- WC-217 (Item 1): cascade the parent FKs of two PURELY-DERIVED child tables so
-- deleting their parent issue/company removes them at the DB level instead of
-- FK-violating (ON DELETE no action / RESTRICT today).
--
-- issue_read_states  = per-(company,issue,user) "last read at" cursor. Pure UI
--                      read-tracking; it has no meaning once the issue/company
--                      is gone.
-- feedback_votes     = per-(company,issue,target,author) thumbs vote. Derived
--                      user feedback; feedback_exports.feedback_vote_id already
--                      ON DELETE CASCADEs (migration 0047), so cascading the vote
--                      also reaps its export rows.
--
-- Both are flagged by the WC-118 "Finding 2" comment as true-orphan tables that
-- the issue/company delete services currently purge MANUALLY in dependency order
-- (issues.remove / companies.remove). Those manual purges remain valid and
-- continue to run; this migration adds the durable DB-level guarantee so any
-- delete path that does NOT go through those services (admin query, future code,
-- a DB-level cascade) can no longer fail with FK 23503 or leave orphans. Both
-- tables hold transient/derived state — never money or audit — so CASCADE (not
-- SET NULL / preserve) is the correct disposition per the schema's per-FK
-- discipline (cf. 0106 cascade vs 0102/0107 preserve).
--
-- userId is a free-text column (no users table / no user FK), so there is no
-- user-parent cascade to add — only the issue and company parents.
ALTER TABLE "issue_read_states" DROP CONSTRAINT IF EXISTS "issue_read_states_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "issue_read_states" DROP CONSTRAINT IF EXISTS "issue_read_states_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "feedback_votes" DROP CONSTRAINT IF EXISTS "feedback_votes_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "feedback_votes" DROP CONSTRAINT IF EXISTS "feedback_votes_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade;
