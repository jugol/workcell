-- WC-72: rename the legacy C-suite agent roles to functional roles. The
-- agents.role column is plain text (no enum), so this migrates existing rows
-- so persisted agents keep their behavior under the new taxonomy. "ceo" was
-- the auth/root role (now "orchestrator"); "cto" was the senior/escalation
-- role (now "lead"). The marketing/finance officer roles are dropped; any
-- existing rows fall back to "general".
UPDATE "agents" SET "role" = 'orchestrator' WHERE "role" = 'ceo';

UPDATE "agents" SET "role" = 'lead' WHERE "role" = 'cto';

UPDATE "agents" SET "role" = 'general' WHERE "role" IN ('cmo', 'cfo');
