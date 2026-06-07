-- WC-212 (production-readiness Wave 1, fix #5): the periodic 30s sweeps
-- (reapOrphanedRuns / resumeQueuedRuns / scanSilentActiveRuns) filter
-- heartbeat_runs on a bare status='running'/'queued' WITHOUT a companyId. Every
-- existing index on this table leads with (company_id, status, ...), so none of
-- them can serve those predicates — each tick falls back to a sequential scan of
-- an unbounded, append-only table. This partial index is keyed on status and
-- restricted to just the active states, so the planner can satisfy the sweeps by
-- touching only the (small) set of in-flight runs.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_active_status_idx" ON "heartbeat_runs" ("status") WHERE "status" IN ('running','queued');
