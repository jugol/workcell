-- Dual-brain pivot: pair collaboration becomes "one agent, two brains".
--
-- pair_groups.kind: "agent_pair" (legacy two-agent pair) | "dual_brain" (ONE
-- agent self-reviewing across two brains; owner === counterpart and the
-- per-brain adapter/model comes from agents.deliberation).
ALTER TABLE "pair_groups" ADD COLUMN "kind" text NOT NULL DEFAULT 'agent_pair';

-- pair_turns.lane: which seat produced the turn ("owner" | "counterpart").
-- Lane — not actor_agent_id — is the identity of a side: in a dual_brain
-- group both lanes are the SAME agent, so role attribution and convergence
-- key on lane.
ALTER TABLE "pair_turns" ADD COLUMN "lane" text;

-- Backfill legacy rows: a turn by the group's owner sat in the owner lane,
-- anything else (counterpart, or a null/foreign actor) in the counterpart
-- lane — the same derivation the orchestrator used implicitly until now.
UPDATE "pair_turns" t
SET "lane" = CASE
  WHEN t."actor_agent_id" IS NOT NULL
    AND t."actor_agent_id" = g."owner_agent_id" THEN 'owner'
  ELSE 'counterpart'
END
FROM "pair_groups" g
WHERE g."id" = t."pair_group_id" AND t."lane" IS NULL;

-- Uniqueness moves from (group, round, actor) to (group, round, lane): the
-- actor-keyed index would reject a dual_brain round (same agent fills both
-- lanes), while the lane-keyed one still gives agent_pair groups the same
-- one-contribution-per-side-per-round guarantee.
DROP INDEX IF EXISTS "pair_turns_actor_unique_per_round";
CREATE UNIQUE INDEX "pair_turns_lane_unique_per_round"
  ON "pair_turns" ("pair_group_id", "round", "lane");
