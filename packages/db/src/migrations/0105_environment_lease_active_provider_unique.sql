-- WC-165: prevent two concurrent runs from both reusing (resuming) the SAME provider
-- sandbox lease. The reuse path is a TOCTOU: two runs both list leases, both find a
-- reusable lease, both resume its provider_lease_id, and both INSERT an active lease —
-- ending up sharing one sandbox concurrently. A unique partial index makes two ACTIVE
-- leases for the same (environment_id, provider_lease_id) impossible, so the loser of
-- the race fails to acquire (and retries / falls back) instead of silently sharing.
-- Released/retained/expired/failed leases are exempt (status <> 'active'), so a
-- reusable sandbox can be re-leased once the prior run frees it.

-- First resolve any pre-existing duplicate active leases (from the bug) so the unique
-- index can be created: keep the most recently acquired active lease per
-- (environment, provider lease) and release the rest. A no-op on a clean database.
UPDATE "environment_leases" SET "status" = 'released', "released_at" = now(), "updated_at" = now()
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "environment_id", "provider_lease_id" ORDER BY "acquired_at" DESC, "id" DESC
    ) AS rn
    FROM "environment_leases"
    WHERE "status" = 'active' AND "provider_lease_id" IS NOT NULL
  ) ranked WHERE ranked.rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environment_leases_active_provider_lease_uq"
  ON "environment_leases" ("environment_id", "provider_lease_id")
  WHERE "status" = 'active' AND "provider_lease_id" IS NOT NULL;
