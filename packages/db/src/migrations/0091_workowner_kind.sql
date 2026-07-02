-- WC-23 (P2 §3 first slice): WorkOwner indirection — add work_owner_kind
-- column to issues. Default "single" reserves the existing semantics; "pair"
-- becomes valid in a future slice that lands PairGroup orchestration.
ALTER TABLE "issues" ADD COLUMN "work_owner_kind" text DEFAULT 'single' NOT NULL;
