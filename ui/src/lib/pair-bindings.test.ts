import { describe, expect, it } from "vitest";
import type { AgentPairBinding } from "@workcell/shared";
import { indexPairBindingsByAgent } from "./pair-bindings";

// WC-189 (checkpoint #5): the agent-side index that powers the pair markers on
// the agent list + org chart. Pure, so it tests without a render harness.

function binding(overrides: Partial<AgentPairBinding> = {}): AgentPairBinding {
  return {
    pairGroupId: "pg-1",
    companyId: "company-1",
    issueId: "issue-1",
    issueIdentifier: "WC-12",
    issueTitle: "Pair candidate",
    status: "active",
    ownerAgentId: "agent-owner",
    ownerAgentName: "Owner",
    counterpartAgentId: "agent-counterpart",
    counterpartAgentName: "Counterpart",
    ...overrides,
  };
}

describe("indexPairBindingsByAgent", () => {
  it("indexes a binding under BOTH agents, each pointing at the other side", () => {
    const map = indexPairBindingsByAgent([binding()]);

    const owner = map.get("agent-owner");
    expect(owner).toHaveLength(1);
    expect(owner![0].counterpartAgentId).toBe("agent-counterpart");
    expect(owner![0].counterpartAgentName).toBe("Counterpart");
    expect(owner![0].issueIdentifier).toBe("WC-12");

    const counterpart = map.get("agent-counterpart");
    expect(counterpart).toHaveLength(1);
    expect(counterpart![0].counterpartAgentId).toBe("agent-owner");
    expect(counterpart![0].counterpartAgentName).toBe("Owner");
  });

  it("returns an empty map for no bindings", () => {
    expect(indexPairBindingsByAgent([]).size).toBe(0);
  });

  it("records the assigned side even when the counterpart is unassigned", () => {
    const map = indexPairBindingsByAgent([
      binding({ counterpartAgentId: null, counterpartAgentName: null }),
    ]);
    // The owner still gets a marker (its counterpart is null/unassigned)...
    expect(map.get("agent-owner")).toHaveLength(1);
    expect(map.get("agent-owner")![0].counterpartAgentId).toBeNull();
    // ...and no phantom entry is created under a null id.
    expect(map.has("")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("collects multiple bindings for an agent paired on multiple issues", () => {
    const map = indexPairBindingsByAgent([
      binding({ pairGroupId: "pg-1", issueId: "issue-1", issueIdentifier: "WC-1" }),
      binding({
        pairGroupId: "pg-2",
        issueId: "issue-2",
        issueIdentifier: "WC-2",
        counterpartAgentId: "agent-other",
        counterpartAgentName: "Other",
      }),
    ]);
    const owner = map.get("agent-owner");
    expect(owner).toHaveLength(2);
    expect(owner!.map((b) => b.issueIdentifier).sort()).toEqual(["WC-1", "WC-2"]);
  });
});
