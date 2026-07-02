-- WC-29 (PLAN §9 #10): enforce activity_log immutability at the storage layer.
--
-- The existing convention treats activity_log as append-only, but nothing
-- prevented an unwary service or a manual DB session from mutating rows
-- after they were written. D17 explicitly called this out as a gap.
--
-- Strategy: a trigger that raises on UPDATE and DELETE on activity_log.
-- Tests that need to clean up activity_log rows still TRUNCATE the table
-- (which is a DDL operation, not subject to row triggers); production
-- code never UPDATEs or DELETEs individual rows.
CREATE OR REPLACE FUNCTION activity_log_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_log is append-only — UPDATE/DELETE on row id=% rejected', OLD.id
    USING ERRCODE = 'feature_not_supported';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS activity_log_block_update ON activity_log;
--> statement-breakpoint
CREATE TRIGGER activity_log_block_update
  BEFORE UPDATE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_block_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS activity_log_block_delete ON activity_log;
--> statement-breakpoint
CREATE TRIGGER activity_log_block_delete
  BEFORE DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_block_mutation();
