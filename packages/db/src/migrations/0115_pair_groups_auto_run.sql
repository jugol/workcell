-- Pair auto-run: pair groups now auto-advance one round per heartbeat tick by
-- default. The column defaults to TRUE so every existing active pair group
-- picks up auto-run on deploy; users opt OUT per group via
-- PATCH /pair-groups/:id { autoRunEnabled: false }. maxRounds / stopPolicy /
-- abort handling in recordTurn/runRound remain the spend safety net.
ALTER TABLE "pair_groups" ADD COLUMN "auto_run_enabled" boolean NOT NULL DEFAULT true;
