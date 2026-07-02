// WC-25 (P2 §3 third slice): per-round contribution by a participant.
// Mirrors the storage shape; metadata stays open so future round engines
// can stamp model/tokens/diffStats without schema churn.
export type PairTurnOutcome = "delivered" | "no_change" | "abort";

// Which seat in the round produced this turn. Lane (not actorAgentId) is the
// identity of a side: in a dual_brain group both lanes are the SAME agent, so
// role attribution and convergence must key on lane.
export type PairTurnLane = "owner" | "counterpart";

export interface PairTurn {
  id: string;
  companyId: string;
  pairGroupId: string;
  round: number;
  lane: PairTurnLane | null;
  actorAgentId: string | null;
  runId: string | null;
  summary: string | null;
  outcome: PairTurnOutcome;
  costCents: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}
