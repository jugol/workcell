-- WC-164: auto-bump issues.execution_state_version whenever execution_state changes.
--
-- WC-163 added the version column + an optimistic-concurrency guard on the issue
-- PATCH path (the route sets the version explicitly). This trigger extends that
-- coverage to EVERY writer of execution_state — a monitor tick, recovery, or any
-- direct UPDATE — so the route's guard detects a concurrent executionState change by
-- a non-route writer (route<->monitor), not only route<->route. It is purely additive:
-- the PATCH path still bumps the version itself (defense-in-depth), and this trigger
-- assigns the same value (OLD + 1) for that path, so there is no double-bump.
CREATE OR REPLACE FUNCTION bump_issue_execution_state_version() RETURNS trigger AS $$
BEGIN
  IF OLD.execution_state IS DISTINCT FROM NEW.execution_state THEN
    NEW.execution_state_version := OLD.execution_state_version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS issue_execution_state_version_bump ON issues;
--> statement-breakpoint
CREATE TRIGGER issue_execution_state_version_bump
  BEFORE UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION bump_issue_execution_state_version();
