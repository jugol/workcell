import type { AgentPairBinding } from "@workcell/shared";

// WC-189 (checkpoint #5): shared helpers for surfacing pair bindings on the
// agent side (agent list + org chart). The issue-level PairGroup is the source
// of truth; these pure helpers flatten the active bindings into a per-agent
// view so both the list and the chart render identical "⇄ 페어" markers
// without duplicating the join logic. Exported + pure so they unit-test
// without a query harness.

// Per-agent view of one pair binding: who the *other* side is (relative to the
// agent the badge is rendered on), plus the issue context for the link.
export interface PairBindingForAgent {
  pairGroupId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  // The agent on the other end of the pair, relative to the agent this entry
  // is keyed under. Either side may be unassigned (null id) — we still record
  // the binding so the agent that IS assigned shows a marker.
  counterpartAgentId: string | null;
  counterpartAgentName: string | null;
}

/**
 * Index active pair bindings by agent id. Each paired agent (owner AND
 * counterpart) gets an entry whose `counterpart*` fields point at the OTHER
 * side. An agent can appear in multiple bindings (paired on multiple issues),
 * so values are arrays. Bindings whose two sides are both null, or that name
 * the same agent on both ends, contribute nothing useful and are skipped per
 * side that is null.
 */
export function indexPairBindingsByAgent(
  bindings: AgentPairBinding[],
): Map<string, PairBindingForAgent[]> {
  const map = new Map<string, PairBindingForAgent[]>();

  const add = (agentId: string | null, entry: PairBindingForAgent) => {
    if (!agentId) return;
    const list = map.get(agentId) ?? [];
    list.push(entry);
    map.set(agentId, list);
  };

  for (const b of bindings) {
    // Entry shown under the OWNER → counterpart is the other (counterpart) side.
    add(b.ownerAgentId, {
      pairGroupId: b.pairGroupId,
      issueId: b.issueId,
      issueIdentifier: b.issueIdentifier,
      issueTitle: b.issueTitle,
      counterpartAgentId: b.counterpartAgentId,
      counterpartAgentName: b.counterpartAgentName,
    });
    // Entry shown under the COUNTERPART → counterpart is the owner side.
    add(b.counterpartAgentId, {
      pairGroupId: b.pairGroupId,
      issueId: b.issueId,
      issueIdentifier: b.issueIdentifier,
      issueTitle: b.issueTitle,
      counterpartAgentId: b.ownerAgentId,
      counterpartAgentName: b.ownerAgentName,
    });
  }

  return map;
}
