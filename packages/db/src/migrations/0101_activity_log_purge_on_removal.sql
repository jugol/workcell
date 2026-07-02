-- WC-116: reconcile the append-only activity_log trigger (WC-29 / 0096) with
-- legitimate entity removal.
--
-- agentService.remove() and companyService.remove() purge a deleted
-- agent's/company's activity_log rows as part of their scoped cascade, but the
-- BEFORE DELETE trigger from 0096 rejected EVERY row delete unconditionally, so
-- the surrounding transaction always rolled back: agent deletion and company
-- hard-deletion were non-functional once any activity existed (the common case).
--
-- Fix: keep append-only for all LIVE audit history — UPDATE is still always
-- rejected, and so is any ordinary/ad-hoc DELETE. A DELETE is permitted ONLY
-- when the caller explicitly opts in for the current transaction via the GUC
-- `workcell.allow_activity_log_purge = 'on'`, which the two removal services set
-- right before their cascade. This catches unwary/buggy mutation exactly as
-- before while letting an entity's own removal purge its rows.
CREATE OR REPLACE FUNCTION activity_log_block_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('workcell.allow_activity_log_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'activity_log is append-only — % on row id=% rejected', TG_OP, OLD.id
    USING ERRCODE = 'feature_not_supported';
END;
$$ LANGUAGE plpgsql;
