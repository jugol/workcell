import type { Db } from "@workcell/db";
import { pairGroupService } from "./pair-groups.js";
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
  previousTurnSummary: string | null;
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

    const turns: Array<{ id: string; outcome: string; round: number }> = [];

    // --- owner turn ---
    const ownerResult = await executor({
      pairGroupId: group.id,
      companyId: group.companyId,
      round: group.currentRound,
      actorAgentId: group.ownerAgentId,
      role: "owner",
      previousTurnSummary: null,
    });
    const ownerRecord = await groupSvc.recordTurn({
      companyId: group.companyId,
      pairGroupId: group.id,
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
      previousTurnSummary: ownerResult.summary,
    });
    const cpRecord = await groupSvc.recordTurn({
      companyId: group.companyId,
      pairGroupId: group.id,
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
