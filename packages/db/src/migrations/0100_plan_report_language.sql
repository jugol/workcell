-- WC-81 (reality-check #6): per-company language for the planner/Orchestrator's
-- plan reports and issue drafts, chosen during onboarding. Defaults to English
-- so existing companies keep writing in English until a board changes it.
ALTER TABLE "companies" ADD COLUMN "plan_report_language" text NOT NULL DEFAULT 'en';
