import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { agents, companies, issues, pairGroups, pairTurns } from "@workcell/db";
import {
  PAIR_GROUP_DEFAULT_MAX_ROUNDS,
  type AgentPairBinding,
  type PairGroupStatus,
  type PairTurnOutcome,
} from "@workcell/shared";
import { closePairWorktrees } from "./pair-workspace.js";
import { latestBindingPerPair, mutuallyExclusivePairBindings } from "./agents.js";
import { badRequest } from "../errors.js";

// WC-24 (P2 §3 second slice): minimal PairGroup service. CRUD only — the
// round orchestration (creating PairTurn rows, advancing currentRound,
// applying stopPolicy) lands in WC-25+. Keeping this service tiny means
// future orchestration can compose on top instead of refactoring around
// scope-bloated helpers.
export function pairGroupService(db: Db) {
  // Shared by listBindingsForCompany / listStandingMutualBindings: company
  // bindings (createdAt DESC — latestBindingPerPair relies on this order)
  // joined with their issue, optionally filtered to one lifecycle status.
  async function fetchBindingRows(companyId: string, status?: PairGroupStatus) {
    // Binding surfaces (agent badges, org chart, standing pairs) are a
    // two-agent concept — dual_brain groups are one agent's internal
    // self-review and must never appear as a binding.
    const conditions = [
      eq(pairGroups.companyId, companyId),
      eq(pairGroups.kind, "agent_pair"),
    ];
    if (status) conditions.push(eq(pairGroups.status, status));
    return db
      .select({
        pairGroupId: pairGroups.id,
        companyId: pairGroups.companyId,
        issueId: pairGroups.issueId,
        status: pairGroups.status,
        ownerAgentId: pairGroups.ownerAgentId,
        counterpartAgentId: pairGroups.counterpartAgentId,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        createdAt: pairGroups.createdAt,
      })
      .from(pairGroups)
      .innerJoin(issues, eq(pairGroups.issueId, issues.id))
      .where(and(...conditions))
      .orderBy(desc(pairGroups.createdAt));
  }

  type BindingRow = Awaited<ReturnType<typeof fetchBindingRows>>[number];

  // Resolve every referenced agent's display name (and status, so callers can
  // drop pairs with terminated members) in one query.
  async function fetchBoundAgents(companyId: string, rows: BindingRow[]) {
    const agentIds = Array.from(
      new Set(
        rows.flatMap((row) =>
          [row.ownerAgentId, row.counterpartAgentId].filter((id): id is string => Boolean(id)),
        ),
      ),
    );
    const agentById = new Map<string, { name: string; status: string }>();
    if (agentIds.length > 0) {
      const agentRows = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
      for (const a of agentRows) agentById.set(a.id, { name: a.name, status: a.status });
    }
    return agentById;
  }

  function denormalizeBinding(
    row: BindingRow,
    agentById: Map<string, { name: string; status: string }>,
  ): AgentPairBinding {
    return {
      pairGroupId: row.pairGroupId,
      companyId: row.companyId,
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier ?? null,
      issueTitle: row.issueTitle,
      status: row.status as PairGroupStatus,
      ownerAgentId: row.ownerAgentId ?? null,
      ownerAgentName: row.ownerAgentId ? agentById.get(row.ownerAgentId)?.name ?? null : null,
      counterpartAgentId: row.counterpartAgentId ?? null,
      counterpartAgentName: row.counterpartAgentId
        ? agentById.get(row.counterpartAgentId)?.name ?? null
        : null,
    };
  }

  return {
    // Create a new pair group bound to an issue. Updates the issue's
    // workOwnerKind to "pair" and stamps pairGroupId in the same transaction
    // so reads see a consistent record. Callers should typically only call
    // this when the issue is fresh — adding pair mode to an in-flight
    // single-owner issue is a future concern.
    create: async (input: {
      companyId: string;
      issueId: string;
      // "agent_pair" (default): legacy two distinct agents. "dual_brain": ONE
      // agent self-reviewing across two brains — counterpart is forced to the
      // owner and the per-brain adapter/model comes from agents.deliberation.
      kind?: "agent_pair" | "dual_brain";
      ownerAgentId?: string | null;
      counterpartAgentId?: string | null;
      maxRounds?: number;
      stopPolicy?: {
        maxRounds?: number;
        abortOn?: string[];
        requireConvergence?: boolean;
      } | null;
      // Auto-run: when omitted, the company-level pairAutoRunDefault decides
      // (team autonomy setting, default TRUE). An explicit input always wins.
      autoRunEnabled?: boolean;
    }) => {
      // Infer dual_brain when both sides are the same agent — callers that
      // predate the kind field (or pass owner===counterpart) get the only
      // semantics that combination can mean.
      const sameAgent =
        Boolean(input.ownerAgentId) && input.ownerAgentId === input.counterpartAgentId;
      const kind = input.kind ?? (sameAgent ? "dual_brain" : "agent_pair");
      if (kind === "dual_brain") {
        if (!input.ownerAgentId) {
          throw badRequest("A dual-brain group needs the owning agent", {
            code: "dual_brain_owner_required",
          });
        }
        if (input.counterpartAgentId && input.counterpartAgentId !== input.ownerAgentId) {
          throw badRequest("A dual-brain group is one agent — counterpart must equal owner", {
            code: "dual_brain_counterpart_mismatch",
          });
        }
      } else if (sameAgent) {
        throw badRequest("An agent pair needs two different agents", {
          code: "pair_agents_must_differ",
        });
      }
      const counterpartAgentId =
        kind === "dual_brain" ? input.ownerAgentId : input.counterpartAgentId;
      // Tenant isolation (review MED): the pair_groups FK references agents(id)
      // with NO company constraint, so without this a caller could bind another
      // tenant's agent (by UUID) or a non-existent agent into the pair. Validate
      // that every provided binding belongs to THIS company before the insert.
      const boundAgentIds = [input.ownerAgentId, counterpartAgentId].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (boundAgentIds.length > 0) {
        const inCompany = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, boundAgentIds)));
        const foundIds = new Set(inCompany.map((r) => r.id));
        const foreign = boundAgentIds.filter((aid) => !foundIds.has(aid));
        if (foreign.length > 0) {
          throw badRequest("Pair agents must belong to this company", {
            code: "pair_agent_not_in_company",
            agentIds: foreign,
          });
        }
      }
      // Team autonomy: when the caller does not say, the company's
      // pairAutoRunDefault decides whether the new group auto-runs. An
      // explicit input.autoRunEnabled (true OR false) always wins. Missing
      // company row falls back to true (mirrors the column default).
      let autoRunEnabled = input.autoRunEnabled;
      if (autoRunEnabled === undefined) {
        const companyRow = await db
          .select({ pairAutoRunDefault: companies.pairAutoRunDefault })
          .from(companies)
          .where(eq(companies.id, input.companyId))
          .limit(1);
        autoRunEnabled = companyRow[0]?.pairAutoRunDefault ?? true;
      }
      return await db.transaction(async (tx) => {
        const [group] = await tx
          .insert(pairGroups)
          .values({
            companyId: input.companyId,
            issueId: input.issueId,
            kind,
            ownerAgentId: input.ownerAgentId ?? null,
            counterpartAgentId: counterpartAgentId ?? null,
            maxRounds: input.maxRounds ?? PAIR_GROUP_DEFAULT_MAX_ROUNDS,
            stopPolicy: input.stopPolicy ?? null,
            autoRunEnabled,
          })
          .returning();
        // Stamp the back-reference + flip workOwnerKind on the parent issue.
        await tx
          .update(issues)
          .set({ workOwnerKind: "pair", pairGroupId: group.id, updatedAt: new Date() })
          .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
        return group;
      });
    },

    // Fetch by id, scoped to a company. Returns null when not found.
    getById: async (companyId: string, id: string) => {
      const rows = await db
        .select()
        .from(pairGroups)
        .where(and(eq(pairGroups.companyId, companyId), eq(pairGroups.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },

    // Fetch the most recent group for an issue (there should typically be
    // only one active group per issue, but lookups by issue + status are
    // safer than assuming single).
    getActiveForIssue: async (companyId: string, issueId: string) => {
      const rows = await db
        .select()
        .from(pairGroups)
        .where(
          and(
            eq(pairGroups.companyId, companyId),
            eq(pairGroups.issueId, issueId),
            eq(pairGroups.status, "active"),
          ),
        )
        .orderBy(desc(pairGroups.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    // WC-189 (checkpoint #5): list pair bindings for a company, denormalized
    // into the agent-side shape. Powers the agent list + org chart pair
    // markers ("⇄ 페어: <counterpart> on <issue REF>"). Defaults to active
    // groups only — a binding is only meaningful to surface on an agent while
    // the pair is live. The issue join supplies the human-readable identifier
    // + title; agent names are resolved in a single follow-up lookup so the
    // payload is self-contained (the UI renders the badge without N calls).
    listBindingsForCompany: async (
      companyId: string,
      options?: { status?: PairGroupStatus },
    ): Promise<AgentPairBinding[]> => {
      const status = options?.status ?? "active";
      const rows = await fetchBindingRows(companyId, status);
      if (rows.length === 0) return [];
      const agentById = await fetchBoundAgents(companyId, rows);
      return rows.map((row) => denormalizeBinding(row, agentById));
    },

    // Standing mutually-exclusive pairs: bindings of EVERY status reduced to
    // the latest group per agent pair, then filtered to pairs whose two
    // members are bound to exactly each other (same semantics as the org
    // chart's single-node merge — latestBindingPerPair +
    // mutuallyExclusivePairBindings are shared with agents.ts). Pairs with a
    // missing or terminated member are dropped: they cannot be offered as an
    // assignee. Powers GET /companies/:id/pair-groups?scope=standing (the
    // assignee picker's "Owner ⇄ Counterpart" option).
    listStandingMutualBindings: async (companyId: string): Promise<AgentPairBinding[]> => {
      const rows = await fetchBindingRows(companyId);
      const standing = mutuallyExclusivePairBindings(latestBindingPerPair(rows));
      if (standing.length === 0) return [];
      const agentById = await fetchBoundAgents(companyId, standing);
      return standing
        .filter((row) => {
          const owner = row.ownerAgentId ? agentById.get(row.ownerAgentId) : null;
          const counterpart = row.counterpartAgentId
            ? agentById.get(row.counterpartAgentId)
            : null;
          return (
            owner && counterpart && owner.status !== "terminated" && counterpart.status !== "terminated"
          );
        })
        .map((row) => denormalizeBinding(row, agentById));
    },

    // Transition status with a stop reason. The reason is required when
    // transitioning out of "active" (the orchestration layer should always
    // record why a group stopped — never silently complete it).
    transitionStatus: async (input: {
      companyId: string;
      id: string;
      status: PairGroupStatus;
      stopReason?: string | null;
    }) => {
      const now = new Date();
      const completedAt = input.status === "active" ? null : now;
      const [updated] = await db
        .update(pairGroups)
        .set({
          status: input.status,
          stopReason: input.stopReason ?? null,
          completedAt,
          updatedAt: now,
        })
        .where(and(eq(pairGroups.companyId, input.companyId), eq(pairGroups.id, input.id)))
        .returning();
      // WC-133 (D21 slice 4): when the pair reaches a terminal state, reap the
      // worktrees it created. Best-effort — a reap failure must never undo the
      // status transition the caller asked for.
      if (updated && input.status !== "active") {
        await closePairWorktrees(db, input.companyId, input.id).catch(() => 0);
      }
      return updated ?? null;
    },

    // Pair auto-run: toggle whether the heartbeat ticker auto-advances this
    // group. Tenant-scoped; returns the updated group, or null when not found.
    setAutoRun: async (input: { companyId: string; id: string; enabled: boolean }) => {
      const [updated] = await db
        .update(pairGroups)
        .set({ autoRunEnabled: input.enabled, updatedAt: new Date() })
        .where(and(eq(pairGroups.companyId, input.companyId), eq(pairGroups.id, input.id)))
        .returning();
      return updated ?? null;
    },

    // Pair auto-run: list groups the ticker should advance — ACTIVE groups with
    // autoRunEnabled across the WHOLE instance (the ticker is a process-level
    // scheduler, not a tenant-scoped API; runRound itself re-checks status and
    // stays tenant-scoped via each group's own companyId). Ordered by
    // updatedAt asc so the longest-idle group is advanced first, which keeps a
    // small groupsPerTick budget fair across many concurrent pairs.
    //
    // dual_brain groups are EXCLUDED: a deliberation agent's self-review must
    // NOT be driven by this lock-free ticker — that ran it concurrently with
    // the issue's QA/execution stage (two agents on one issue). Self-review is
    // moving to the heartbeat execution layer (phase B); legacy dual_brain rows
    // become inert here. Only agent_pair groups auto-run.
    listAutoRunnable: async (limit = 10) => {
      return db
        .select()
        .from(pairGroups)
        .where(
          and(
            eq(pairGroups.status, "active"),
            eq(pairGroups.autoRunEnabled, true),
            eq(pairGroups.kind, "agent_pair"),
          ),
        )
        .orderBy(asc(pairGroups.updatedAt))
        .limit(limit);
    },

    // WC-25: record a participant's contribution for the current round and
    // advance the group state in a single transaction. The round number is
    // taken from group.currentRound (the orchestration layer is expected to
    // increment it via advanceRound() between rounds, NOT here — recording
    // a turn does not in itself bump the round).
    //
    // Returns the inserted turn + the resulting group state after applying
    // any stop policy that fired.
    //
    // Auto-stop conditions evaluated:
    //   - outcome === "abort" → group transitions to "aborted" with reason
    //     "actor_abort:<actorAgentId>".
    //   - group.currentRound >= group.maxRounds → "aborted" /
    //     "max_rounds_reached" (only if not already aborted).
    //   - convergence (DEFAULT ON, bidirectional sign-off): outcome
    //     "no_change" when the OTHER participant's most recent turn (any
    //     round) was "delivered" → "completed" / "convergence_reached".
    //     Either side can sign off on the other's latest delivered work.
    //     Opt OUT with stopPolicy.requireConvergence === false.
    recordTurn: async (input: {
      companyId: string;
      pairGroupId: string;
      // Which seat this turn fills. Optional for legacy callers — derived
      // from the group (actor === owner → "owner") when absent; REQUIRED in
      // practice for dual_brain groups, where both seats are the same agent
      // and the derivation would always say "owner".
      lane?: "owner" | "counterpart";
      actorAgentId: string | null;
      runId?: string | null;
      summary?: string | null;
      outcome?: PairTurnOutcome;
      costCents?: number;
      metadata?: Record<string, unknown>;
    }) => {
      const result = await db.transaction(async (tx) => {
        const group = await tx
          .select()
          .from(pairGroups)
          .where(
            and(
              eq(pairGroups.companyId, input.companyId),
              eq(pairGroups.id, input.pairGroupId),
            ),
          )
          .then((rows) => rows[0]);
        if (!group) {
          throw new Error("pair group not found");
        }
        if (group.status !== "active") {
          throw new Error(`cannot record turn on group with status="${group.status}"`);
        }

        // WC-52: stopPolicy.maxRounds overrides the column when set (the
        // public contract documents it as an override); fall back to the
        // column, then the default cap.
        const effectiveMax =
          group.stopPolicy?.maxRounds ?? group.maxRounds ?? PAIR_GROUP_DEFAULT_MAX_ROUNDS;

        // WC-52: cap pre-check — evaluate the round budget BEFORE inserting
        // and billing a turn. Previously the cap was an else-if AFTER the
        // insert+cost update, so a turn at currentRound==max was recorded and
        // billed before the abort fired (wasting a real LLM turn and writing a
        // stray ledger row). Now an at/over-cap call aborts cleanly with no
        // turn and no cost. Rounds are 0-indexed, so currentRound==max means
        // all `max` rounds (0..max-1) are already used.
        if (group.currentRound >= effectiveMax) {
          const cappedAt = new Date();
          const [capped] = await tx
            .update(pairGroups)
            .set({
              status: "aborted",
              stopReason: "max_rounds_reached",
              completedAt: cappedAt,
              updatedAt: cappedAt,
            })
            .where(eq(pairGroups.id, input.pairGroupId))
            .returning();
          return { turn: null, group: capped };
        }

        const cost = input.costCents ?? 0;
        const outcome = input.outcome ?? "delivered";
        const lane =
          input.lane ??
          (input.actorAgentId && input.actorAgentId === group.ownerAgentId
            ? "owner"
            : "counterpart");
        const [turn] = await tx
          .insert(pairTurns)
          .values({
            companyId: input.companyId,
            pairGroupId: input.pairGroupId,
            round: group.currentRound,
            lane,
            actorAgentId: input.actorAgentId,
            runId: input.runId ?? null,
            summary: input.summary ?? null,
            outcome,
            costCents: cost,
            metadata: input.metadata ?? {},
          })
          // WC-128: two concurrent run-round requests both read the same
          // currentRound and try to record the same (group, round, lane) turn.
          // The `pair_turns_lane_unique_per_round` index makes the loser a
          // no-op instead of throwing (which would 500 the route and abort the
          // transaction). Degrade gracefully below: no new turn, no
          // double-billing, return the current group state.
          .onConflictDoNothing()
          .returning();
        if (!turn) {
          const current = await tx
            .select()
            .from(pairGroups)
            .where(eq(pairGroups.id, input.pairGroupId))
            .then((rows) => rows[0]);
          return { turn: null as null, group: current, conflict: true as const };
        }

        // Maintain the group's aggregate cost in lockstep so callers don't
        // have to re-sum every read.
        await tx
          .update(pairGroups)
          .set({
            totalCostCents: sql`${pairGroups.totalCostCents} + ${cost}`,
            updatedAt: new Date(),
          })
          .where(eq(pairGroups.id, input.pairGroupId));

        // Evaluate auto-stop conditions. The max-rounds cap is handled by the
        // pre-check above, so the post-insert chain is just abort vs
        // convergence — and convergence is therefore reachable on the final
        // valid round (it is no longer pre-empted by the cap branch).
        // WC-52: honor stopPolicy.abortOn — a configured list of outcomes that
        // should abort the group (previously stored but never read).
        let stopReason: string | null = null;
        let stopStatus: PairGroupStatus | null = null;
        const abortOutcomes = group.stopPolicy?.abortOn ?? [];
        if (outcome === "abort") {
          stopStatus = "aborted";
          stopReason = `actor_abort:${input.actorAgentId ?? "unknown"}`;
        } else if (abortOutcomes.includes(outcome)) {
          stopStatus = "aborted";
          stopReason = `abort_policy:${outcome}`;
        } else if (
          // Convergence is the DEFAULT exit: a group created without a
          // stopPolicy (e.g. via onboarding) must still complete when the
          // counterpart signs off with no_change — previously it kept
          // burning rounds until maxRounds and ended "aborted". Only an
          // explicit stopPolicy.requireConvergence === false opts out.
          group.stopPolicy?.requireConvergence !== false &&
          outcome === "no_change"
        ) {
          // Bidirectional sign-off semantics: EITHER side signs off on the
          // other's latest delivered work. A no_change converges when the
          // most recent turn by the OTHER LANE — across ALL rounds, not just
          // the current one — was "delivered". Lane (not actor) is the side
          // identity: in a dual_brain group both lanes are the same agent.
          // This covers both:
          //   (a) the classic same-round case (owner delivers, counterpart
          //       OKs later the same round), and
          //   (b) the cross-round case (counterpart delivered round N-1 with
          //       its own direct improvements; the owner opens round N and
          //       signs off → the group completes mid-round).
          // If the other lane has no turns at all (e.g. a round-0 owner
          // saying no_change into the void), there is nothing to sign off
          // on — the group stays active.
          const otherLaneTurns = await tx
            .select({
              id: pairTurns.id,
              outcome: pairTurns.outcome,
              lane: pairTurns.lane,
              actorAgentId: pairTurns.actorAgentId,
            })
            .from(pairTurns)
            .where(eq(pairTurns.pairGroupId, input.pairGroupId))
            .orderBy(desc(pairTurns.round), desc(pairTurns.createdAt));
          const latestOtherTurn = otherLaneTurns.find(
            (t) =>
              t.id !== turn.id &&
              // Pre-0117 rows are lane-backfilled by the migration, but stay
              // defensive: a null lane falls back to the actor comparison.
              (t.lane ? t.lane !== lane : t.actorAgentId !== (input.actorAgentId ?? null)),
          );
          if (latestOtherTurn?.outcome === "delivered") {
            stopStatus = "completed";
            stopReason = "convergence_reached";
          }
        }
        let finalGroup = await tx
          .select()
          .from(pairGroups)
          .where(eq(pairGroups.id, input.pairGroupId))
          .then((rows) => rows[0]);
        if (stopStatus) {
          const now = new Date();
          const [transitioned] = await tx
            .update(pairGroups)
            .set({
              status: stopStatus,
              stopReason,
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(pairGroups.id, input.pairGroupId))
            .returning();
          finalGroup = transitioned;
        }
        return { turn, group: finalGroup };
      });
      // WC-133 (D21 slice 4): if this turn drove the pair to a terminal state
      // (convergence / abort / cap), reap the worktrees the pair created.
      // Best-effort + outside the txn — never blocks recording the turn.
      if (result.group && result.group.status && result.group.status !== "active") {
        await closePairWorktrees(db, input.companyId, input.pairGroupId).catch(() => 0);
      }
      return result;
    },

    // WC-25: bump currentRound by one. Caller is expected to invoke this
    // between rounds (i.e. after all participants for round N have recorded
    // their turns). Cap-checked: refuses to advance past maxRounds.
    advanceRound: async (input: { companyId: string; pairGroupId: string }) => {
      return await db.transaction(async (tx) => {
        const group = await tx
          .select()
          .from(pairGroups)
          .where(
            and(
              eq(pairGroups.companyId, input.companyId),
              eq(pairGroups.id, input.pairGroupId),
            ),
          )
          .then((rows) => rows[0]);
        if (!group) return null;
        if (group.status !== "active") return group;
        // WC-52: honor stopPolicy.maxRounds override here too, consistent with
        // recordTurn's cap pre-check.
        const effectiveMax =
          group.stopPolicy?.maxRounds ?? group.maxRounds ?? PAIR_GROUP_DEFAULT_MAX_ROUNDS;
        const nextRound = group.currentRound + 1;
        if (nextRound > effectiveMax) {
          // Refuse silently; caller should observe currentRound = maxRounds
          // and decide to call transitionStatus("aborted") if desired.
          return group;
        }
        const [updated] = await tx
          .update(pairGroups)
          .set({ currentRound: nextRound, updatedAt: new Date() })
          .where(eq(pairGroups.id, input.pairGroupId))
          .returning();
        return updated;
      });
    },

    // WC-25: list turns for a group, ordered by (round asc, createdAt asc).
    listTurnsForGroup: async (companyId: string, pairGroupId: string) => {
      return db
        .select()
        .from(pairTurns)
        .where(
          and(
            eq(pairTurns.companyId, companyId),
            eq(pairTurns.pairGroupId, pairGroupId),
          ),
        )
        .orderBy(pairTurns.round, pairTurns.createdAt);
    },
  };
}
