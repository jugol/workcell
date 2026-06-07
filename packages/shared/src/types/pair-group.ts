import type { PairGroupStatus } from "../constants.js";

// WC-24 (P2 §3 second slice): PairGroup runtime shape. Returned by the
// pair-group endpoints (later slice). Fields mirror the DB schema; nulls
// reflect the actual storage shape (e.g. completedAt is set only when
// status transitions out of "active").
export interface PairGroup {
  id: string;
  companyId: string;
  issueId: string;
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
