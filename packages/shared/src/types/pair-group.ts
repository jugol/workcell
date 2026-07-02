import type { PairGroupStatus } from "../constants.js";

// WC-24 (P2 §3 second slice): PairGroup runtime shape. Returned by the
// pair-group endpoints (later slice). Fields mirror the DB schema; nulls
// reflect the actual storage shape (e.g. completedAt is set only when
// status transitions out of "active").
// Dual-brain pivot: a pair group is either the legacy two-agent pair
// ("agent_pair") or ONE agent self-reviewing across two brains
// ("dual_brain", owner === counterpart; per-brain adapter/model comes from
// the agent's deliberation config).
export type PairGroupKind = "agent_pair" | "dual_brain";

export interface PairGroup {
  id: string;
  companyId: string;
  issueId: string;
  kind: PairGroupKind;
  ownerAgentId: string | null;
  counterpartAgentId: string | null;
  currentRound: number;
  maxRounds: number;
  stopPolicy: {
    maxRounds?: number;
    abortOn?: string[];
    requireConvergence?: boolean;
  } | null;
  status: PairGroupStatus;
  stopReason: string | null;
  totalCostCents: number;
  // Auto-run: when true (the default), the heartbeat scheduler advances this
  // pair one round per tick without a human pressing "Run round". Users opt
  // OUT by toggling it off; maxRounds/stopPolicy still cap total spend.
  autoRunEnabled: boolean;
  // In-flight round state (server pairRunRegistry). Optional because only
  // GET /issues/:id/pair-group decorates the group with it — other response
  // paths (create/patch/advance) omit it. `runInFlightSource` tells the UI
  // whether the manual route or the auto-run ticker is driving the round.
  runInFlight?: boolean;
  runInFlightSource?: "manual" | "auto_run" | null;
  // heartbeat_runs.id of the pair turn currently executing inside the
  // in-flight round (live LLM path promotes each turn to a real run record).
  // Null while no turn is mid-flight (e.g. between owner and counterpart
  // turns) and always null on the stub path.
  runInFlightRunId?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

// WC-189 (checkpoint #5): agent-side view of a pair binding. The issue-level
// PairGroup is the source of truth, but the agent list / org chart need a
// flattened, denormalized shape so each paired agent can render
// "⇄ 페어: <counterpart> (on REF)" without N extra lookups. Returned by
// GET /companies/:companyId/pair-groups?status=active. Names + the issue
// identifier are resolved server-side so the UI can render a complete badge
// from one payload.
export interface AgentPairBinding {
  pairGroupId: string;
  companyId: string;
  issueId: string;
  // Human-readable issue identifier (e.g. "WC-12") when assigned; null for
  // issues that never got a number.
  issueIdentifier: string | null;
  issueTitle: string;
  status: PairGroupStatus;
  ownerAgentId: string | null;
  ownerAgentName: string | null;
  counterpartAgentId: string | null;
  counterpartAgentName: string | null;
}

export type { PairGroupStatus };
