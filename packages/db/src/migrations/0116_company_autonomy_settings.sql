-- Team autonomy settings (company-level). Previously the only switch was the
-- instance-level EXPERIMENTAL autonomousMode flag, which silently auto-accepted
-- request_confirmation gates across every company. These columns make the
-- per-step autonomy explicit and per-team:
--   auto_approve_confirmations (default FALSE): auto-accept agent
--     request_confirmation gates as the system instead of waiting for the board.
--   auto_route_new_issues (default TRUE): board-created top-level issues with
--     no explicit assignee are auto-routed to the Orchestrator (lead fallback).
--   pair_auto_run_default (default TRUE): default autoRunEnabled for new pair
--     groups created without an explicit input (mirrors 0115's column default).
ALTER TABLE "companies" ADD COLUMN "auto_approve_confirmations" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "auto_route_new_issues" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "pair_auto_run_default" boolean NOT NULL DEFAULT true;
