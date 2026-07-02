import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@workcell/db";
import { pairGroupService } from "./pair-groups.js";
import { autoStartIssueForPairRound } from "./issue-auto-start.js";
import { PAIR_GROUP_DEFAULT_MAX_ROUNDS, type PairTurnOutcome } from "@workcell/shared";

// WC-32 (P2 §3 driver loop): orchestrates one full round on a PairGroup.
//
// Each round = (1) owner agent produces output → recordTurn,
//              (2) counterpart reviews → recordTurn,
//              (3) advanceRound if group is still active.
//
// Adapter integration is pluggable: pairTurnExecutor is a function that
// takes a turn request (group, round, actor) and returns the produced
// summary + cost + outcome. The default executor used in tests is a
// caller-provided mock; the real adapter-driven executor lands in WC-33.
//
// Why orchestrator separate from PairGroup service: the service is
// pure CRUD over the ledger; this layer handles the procedural "run one
// round" semantics — including the executor call, error handling, and
// post-round bookkeeping (advance the round counter once both
// participants have contributed).

export interface PairTurnRequest {
  pairGroupId: string;
  companyId: string;
  round: number;
  actorAgentId: string;
  role: "owner" | "counterpart";
  // "dual_brain" = one agent self-reviewing across two brains; the executor
  // switches the prompt (self-review framing) and the adapter/model per role
  // (agents.deliberation brainA/brainB). Optional so hand-built requests in
  // tests stay valid — absent means the legacy two-agent pair.
  groupKind?: "agent_pair" | "dual_brain";
  previousTurnSummary: string | null;
  // Compact round history (oldest first, capped at the most recent turns)
  // so both actors see how the conversation evolved, not just the single
  // previous turn. Optional for backwards compatibility — existing executors
  // and tests that build a PairTurnRequest by hand stay valid.
  recentTurns?: Array<{
    round: number;
    role: "owner" | "counterpart";
    outcome: string;
    summary: string | null;
  }>;
}

export interface PairTurnExecutionResult {
  summary: string;
  outcome?: PairTurnOutcome;
  costCents?: number;
  metadata?: Record<string, unknown>;
}

export type PairTurnExecutor = (
  request: PairTurnRequest,
) => Promise<PairTurnExecutionResult>;

export interface PairRoundResult {
  skipped: boolean;
  reason?: string;
  group: any;
  turns?: Array<{ id: string; outcome: string; round: number }>;
  stoppedAfter?: "owner" | "counterpart" | "cap" | null;
}

export function pairRoundOrchestrator(db: Db, executor: PairTurnExecutor) {
  const groupSvc = pairGroupService(db);

  async function runRound(input: {
    companyId: string;
    pairGroupId: string;
  }): Promise<PairRoundResult> {
    const group = await groupSvc.getById(input.companyId, input.pairGroupId);
    if (!group) throw new Error("pair group not found");
    if (group.status !== "active") {
      return { skipped: true, reason: `status="${group.status}"`, group };
    }
    if (!group.ownerAgentId || !group.counterpartAgentId) {
      return {
        skipped: true,
        reason: "missing participants (owner or counterpart agent not set)",
        group,
      };
    }

    // Board stop is final: a round must never run against a closed issue.
    // Cancelling/completing an issue didn't stop its pair group, so the
    // auto-run ticker kept spending rounds on work the board had killed.
    // Abort the group here (single chokepoint for ticker AND manual route)
    // so it drops out of listAutoRunnable — self-healing for groups that
    // were live when their issue closed.
    const issueRow = await db
      .select({ status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, group.companyId), eq(issues.id, group.issueId)))
      .then((rows) => rows[0] ?? null);
    if (!issueRow || issueRow.status === "cancelled" || issueRow.status === "done") {
      const stopped = await groupSvc.transitionStatus({
        companyId: group.companyId,
        id: group.id,
        status: "aborted",
        stopReason: issueRow ? `issue_${issueRow.status}` : "issue_missing",
      });
      return { skipped: true, reason: "source issue is closed", group: stopped ?? group };
    }

    // WC-52: cap pre-check BEFORE spending an (expensive) executor/LLM call.
    // The round budget is exhausted once currentRound has reached the cap;
    // abort cleanly without invoking the executor or recording a turn.
    const effectiveMax =
      group.stopPolicy?.maxRounds ?? group.maxRounds ?? PAIR_GROUP_DEFAULT_MAX_ROUNDS;
    if (group.currentRound >= effectiveMax) {
      const stopped = await groupSvc.transitionStatus({
        companyId: group.companyId,
        id: group.id,
        status: "aborted",
        stopReason: "max_rounds_reached",
      });
      return { skipped: false, group: stopped, turns: [], stoppedAfter: "cap" };
    }

    // A round is about to actually run → the issue's work has started. Flip a
    // backlog/todo issue to in_progress so the board reflects reality instead
    // of waiting for the agent to self-checkout. Best-effort + idempotent
    // (conditional update inside the helper); never blocks the round.
    await autoStartIssueForPairRound(db, {
      companyId: group.companyId,
      issueId: group.issueId,
      pairGroupId: group.id,
      ownerAgentId: group.ownerAgentId,
    });

    const turns: Array<{ id: string; outcome: string; round: number }> = [];

    // Fetch the turn ledger ONCE per round, BEFORE the owner turn is
    // recorded, so that:
    //   (a) the owner sees the counterpart's most recent review as its
    //       previousTurnSummary (previously the owner was always called with
    //       null and re-proposed blind, ignoring round N-1's feedback), and
    //   (b) both actors receive the same compact round history — which
    //       naturally excludes the owner turn recorded later this round
    //       (the counterpart already gets it via previousTurnSummary).
    const priorTurns = await groupSvc.listTurnsForGroup(group.companyId, group.id);
    // Lane is the side identity (dual_brain groups have the SAME agent in
    // both seats); pre-0117 rows are lane-backfilled, but stay defensive and
    // fall back to the actor comparison when lane is null.
    const laneOf = (t: { lane?: string | null; actorAgentId: string | null }) =>
      (t.lane === "owner" || t.lane === "counterpart"
        ? t.lane
        : t.actorAgentId === group.ownerAgentId
          ? "owner"
          : "counterpart") as "owner" | "counterpart";
    const lastCounterpartTurn =
      [...priorTurns].reverse().find((t) => laneOf(t) === "counterpart") ?? null;
    const recentTurns = priorTurns.slice(-6).map((t) => ({
      round: t.round,
      role: laneOf(t),
      outcome: t.outcome,
      summary: t.summary,
    }));
    const groupKind = (group.kind === "dual_brain" ? "dual_brain" : "agent_pair") as
      | "agent_pair"
      | "dual_brain";

    // --- owner turn ---
    const ownerResult = await executor({
      pairGroupId: group.id,
      companyId: group.companyId,
      round: group.currentRound,
      actorAgentId: group.ownerAgentId,
      role: "owner",
      groupKind,
      // Round 1 has no prior review → null; later rounds carry the
      // counterpart's latest summary so the owner can address the feedback.
      previousTurnSummary: lastCounterpartTurn?.summary ?? null,
      recentTurns,
    });
    const ownerRecord = await groupSvc.recordTurn({
      companyId: group.companyId,
      pairGroupId: group.id,
      lane: "owner",
      actorAgentId: group.ownerAgentId,
      summary: ownerResult.summary,
      outcome: ownerResult.outcome ?? "delivered",
      costCents: ownerResult.costCents ?? 0,
      metadata: ownerResult.metadata,
    });
    // recordTurn returns turn=null only if its own cap pre-check fired (a
    // defense-in-depth race with the check above) — treat as a stop.
    if (ownerRecord.turn) {
      turns.push({
        id: ownerRecord.turn.id,
        outcome: ownerRecord.turn.outcome,
        round: ownerRecord.turn.round,
      });
    }
    if (!ownerRecord.turn || ownerRecord.group?.status !== "active") {
      return {
        skipped: false,
        group: ownerRecord.group,
        turns,
        stoppedAfter: "owner",
      };
    }

    // --- counterpart turn ---
    const cpResult = await executor({
      pairGroupId: group.id,
      companyId: group.companyId,
      round: group.currentRound,
      actorAgentId: group.counterpartAgentId,
      role: "counterpart",
      groupKind,
      previousTurnSummary: ownerResult.summary,
      // Same pre-owner-turn snapshot: the owner turn just recorded above is
      // intentionally NOT in recentTurns (it is the previousTurnSummary).
      recentTurns,
    });
    const cpRecord = await groupSvc.recordTurn({
      companyId: group.companyId,
      pairGroupId: group.id,
      lane: "counterpart",
      actorAgentId: group.counterpartAgentId,
      summary: cpResult.summary,
      outcome: cpResult.outcome ?? "delivered",
      costCents: cpResult.costCents ?? 0,
      metadata: cpResult.metadata,
    });
    if (cpRecord.turn) {
      turns.push({
        id: cpRecord.turn.id,
        outcome: cpRecord.turn.outcome,
        round: cpRecord.turn.round,
      });
    }
    if (!cpRecord.turn || cpRecord.group?.status !== "active") {
      return {
        skipped: false,
        group: cpRecord.group,
        turns,
        stoppedAfter: "counterpart",
      };
    }

    // Both participants contributed and the group is still active —
    // advance the round counter for the next call.
    const advanced = await groupSvc.advanceRound({
      companyId: group.companyId,
      pairGroupId: group.id,
    });
    return {
      skipped: false,
      group: advanced ?? cpRecord.group,
      turns,
      stoppedAfter: null,
    };
  }

  return {
    runRound,
    // Run rounds in a loop until the group stops or maxRoundsToRun is hit.
    // The cap is separate from the group's own maxRounds — useful when a
    // single API call should drive only a bounded number of rounds.
    runUntilStop: async (input: {
      companyId: string;
      pairGroupId: string;
      maxRoundsToRun: number;
    }) => {
      const results: PairRoundResult[] = [];
      for (let i = 0; i < input.maxRoundsToRun; i++) {
        const result = await runRound({
          companyId: input.companyId,
          pairGroupId: input.pairGroupId,
        });
        results.push(result);
        if (result.skipped) break;
        if (result.group?.status !== "active") break;
      }
      return results;
    },
  };
}
