// WC-25 (P2 §3 third slice): per-round contribution by a participant.
// Mirrors the storage shape; metadata stays open so future round engines
// can stamp model/tokens/diffStats without schema churn.
export type PairTurnOutcome = "delivered" | "no_change" | "abort";

export interface PairTurn {
  id: string;
  companyId: string;
  pairGroupId: string;
  round: number;
  actorAgentId: string | null;
  runId: string | null;
  summary: string | null;
  outcome: PairTurnOutcome;
  costCents: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}
