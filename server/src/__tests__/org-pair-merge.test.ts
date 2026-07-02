import { describe, expect, it } from "vitest";
import { agents, pairGroups } from "@workcell/db";
import { agentService, latestBindingPerPair, mergeMutualPairsForOrg } from "../services/agents.ts";

// Org chart pair merging: a mutually-exclusive pair (owner ⇄ counterpart)
// collapses into ONE org node keyed by the owner, carrying the counterpart as
// `pair` and BOTH members' reports. The pairing is durable: groups of EVERY
// status participate (a completed/aborted group keeps the pair merged for the
// next issue), and per agent pair only the most recent group counts. Agents
// whose latest groups span several partners are left untouched (safe fallback
// to the old two-node rendering).

interface StubAgentRow {
  id: string;
  name: string;
  role: string;
  status: string;
  reportsTo: string | null;
  permissions: null;
}

interface StubPairRow {
  ownerAgentId: string | null;
  counterpartAgentId: string | null;
}

function makeAgent(
  id: string,
  name: string,
  reportsTo: string | null,
  role = "engineer",
  status = "active",
): StubAgentRow {
  return { id, name, role, status, reportsTo, permissions: null };
}

/**
 * Minimal Drizzle stub for agentService.orgForCompany: two selects, routed by
 * the table handed to from() — the agents query resolves agent rows, the
 * pairGroups query resolves binding rows. The real pairGroups query selects
 * groups of EVERY status ordered by createdAt DESC, so `pairRows` must be
 * listed NEWEST FIRST; the agents query awaits .where() directly while the
 * pairGroups query chains .orderBy() — the stub satisfies both shapes.
 */
function createDb(agentRows: StubAgentRow[], pairRows: StubPairRow[]) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === pairGroups ? pairRows : table === agents ? agentRows : [];
        const resolved = Promise.resolve(rows);
        return { where: () => Object.assign(resolved, { orderBy: () => resolved }) };
      },
    }),
  } as never;
}

type OrgTreeNode = {
  id: string;
  name: string;
  reports: OrgTreeNode[];
  pair?: { id: string; name: string; role: string; status: string };
};

function findNode(nodes: OrgTreeNode[], id: string): OrgTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findNode(node.reports, id);
    if (hit) return hit;
  }
  return null;
}

function collectIds(nodes: OrgTreeNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...collectIds(node.reports)]);
}

describe("orgForCompany pair merging", () => {
  it("merges a mutual pair into one node: counterpart leaves the tree and rides along as `pair`", async () => {
    const rows = [
      makeAgent("ceo", "CEO", null, "ceo"),
      makeAgent("owner", "Orchestrator", "ceo"),
      makeAgent("counterpart", "Orchestrator 2", "ceo"),
      makeAgent("sub-owner", "Worker A", "owner"),
      makeAgent("sub-counterpart", "Worker B", "counterpart"),
    ];
    const svc = agentService(createDb(rows, [
      { ownerAgentId: "owner", counterpartAgentId: "counterpart" },
    ]));

    const tree = (await svc.orgForCompany("company-1")) as unknown as OrgTreeNode[];

    // Counterpart no longer appears as its own node anywhere.
    expect(collectIds(tree)).not.toContain("counterpart");

    // The owner node carries the counterpart summary.
    const merged = findNode(tree, "owner");
    expect(merged).not.toBeNull();
    expect(merged!.pair).toMatchObject({
      id: "counterpart",
      name: "Orchestrator 2",
      role: "engineer",
      status: "active",
    });

    // BOTH sides' reports hang under the merged (primary) node.
    const reportIds = merged!.reports.map((r) => r.id).sort();
    expect(reportIds).toEqual(["sub-counterpart", "sub-owner"]);
  });

  it("promotes agents with a DANGLING reportsTo (deleted manager) to roots instead of dropping them", async () => {
    // Live regression: Coder/QA/Designer pointed at an old Orchestrator that
    // no longer existed, and the whole subtree silently vanished from the
    // chart — only the current root rendered.
    const rows = [
      makeAgent("orch", "Orchestrator", null, "orchestrator"),
      makeAgent("coder", "Coder", "ghost-manager-id"),
      makeAgent("qa", "QA", "ghost-manager-id"),
    ];
    const svc = agentService(createDb(rows, []));

    const tree = (await svc.orgForCompany("company-1")) as unknown as OrgTreeNode[];

    // Nobody disappears: the orphans surface as roots next to the real root.
    expect(collectIds(tree).sort()).toEqual(["coder", "orch", "qa"]);
    expect(tree.map((node) => node.id).sort()).toEqual(["coder", "orch", "qa"]);
  });

  it("returns the exact pre-merge tree when there are no pair groups at all", async () => {
    const rows = [
      makeAgent("ceo", "CEO", null, "ceo"),
      makeAgent("eng", "Engineer", "ceo"),
      makeAgent("worker", "Worker", "eng"),
    ];
    const svc = agentService(createDb(rows, []));

    const tree = (await svc.orgForCompany("company-1")) as unknown as OrgTreeNode[];

    expect(collectIds(tree)).toEqual(["ceo", "eng", "worker"]);
    expect(findNode(tree, "ceo")!.reports.map((r) => r.id)).toEqual(["eng"]);
    expect(findNode(tree, "eng")!.reports.map((r) => r.id)).toEqual(["worker"]);
    // No node grows a pair field.
    expect(tree.every((node) => !("pair" in node))).toBe(true);
    expect(findNode(tree, "eng")).not.toHaveProperty("pair");
  });

  it("treats reportsTo pointing inside the pair as null (no cycle): counterpart→owner merges to a root node", async () => {
    const rows = [
      makeAgent("owner", "Orchestrator", null),
      makeAgent("counterpart", "Orchestrator 2", "owner"),
      makeAgent("sub", "Worker", "counterpart"),
    ];
    const svc = agentService(createDb(rows, [
      { ownerAgentId: "owner", counterpartAgentId: "counterpart" },
    ]));

    const tree = (await svc.orgForCompany("company-1")) as unknown as OrgTreeNode[];

    // Merged node is a root (owner had no manager; counterpart pointed at the
    // owner, which is inside the pair → treated as null).
    expect(tree.map((node) => node.id)).toEqual(["owner"]);
    expect(tree[0]!.pair).toMatchObject({ id: "counterpart" });
    expect(tree[0]!.reports.map((r) => r.id)).toEqual(["sub"]);
  });

  it("falls back to the counterpart's manager when the owner reports INTO the pair", async () => {
    const rows = [
      makeAgent("ceo", "CEO", null, "ceo"),
      makeAgent("owner", "Orchestrator", "counterpart"),
      makeAgent("counterpart", "Orchestrator 2", "ceo"),
    ];
    const svc = agentService(createDb(rows, [
      { ownerAgentId: "owner", counterpartAgentId: "counterpart" },
    ]));

    const tree = (await svc.orgForCompany("company-1")) as unknown as OrgTreeNode[];

    // owner.reportsTo points at the counterpart (inside the pair) → fall back
    // to counterpart.reportsTo, so the merged node lands under the CEO.
    const ceo = findNode(tree, "ceo");
    expect(ceo!.reports.map((r) => r.id)).toEqual(["owner"]);
    expect(findNode(tree, "owner")!.pair).toMatchObject({ id: "counterpart" });
  });

  it("does NOT merge an agent whose latest groups span two different partners", async () => {
    const rows = [
      makeAgent("a", "Agent A", null),
      makeAgent("b", "Agent B", null),
      makeAgent("c", "Agent C", null),
    ];
    // A-B and A-C are each the LATEST group for their pair (any status), so A
    // spans two partners → none of A's pairs merge. B⇄C does not exist.
    const svc = agentService(createDb(rows, [
      { ownerAgentId: "a", counterpartAgentId: "b" },
      { ownerAgentId: "a", counterpartAgentId: "c" },
    ]));

    const tree = (await svc.orgForCompany("company-1")) as unknown as OrgTreeNode[];

    expect(collectIds(tree).sort()).toEqual(["a", "b", "c"]);
    expect(tree.every((node) => !("pair" in node))).toBe(true);
  });

  it("does NOT merge when one side is in a half-open binding (unassigned counterpart)", async () => {
    const rows = [
      makeAgent("a", "Agent A", null),
      makeAgent("b", "Agent B", null),
    ];
    const svc = agentService(createDb(rows, [
      { ownerAgentId: "a", counterpartAgentId: "b" },
      { ownerAgentId: "a", counterpartAgentId: null },
    ]));

    const tree = (await svc.orgForCompany("company-1")) as unknown as OrgTreeNode[];

    expect(collectIds(tree).sort()).toEqual(["a", "b"]);
    expect(tree.every((node) => !("pair" in node))).toBe(true);
  });

  it("merges once when the same pair has a new active group and an old aborted one", async () => {
    const rows = [
      makeAgent("owner", "Orchestrator", null),
      makeAgent("counterpart", "Orchestrator 2", null),
    ];
    // Rows are createdAt DESC: a fresh active group plus an older aborted
    // group from a previous issue. latestBindingPerPair keeps the newest →
    // exactly one merge.
    const svc = agentService(createDb(rows, [
      { ownerAgentId: "owner", counterpartAgentId: "counterpart" },
      { ownerAgentId: "owner", counterpartAgentId: "counterpart" },
    ]));

    const tree = (await svc.orgForCompany("company-1")) as unknown as OrgTreeNode[];

    expect(tree.map((node) => node.id)).toEqual(["owner"]);
    expect(tree[0]!.pair).toMatchObject({ id: "counterpart" });
  });

  it("keeps the pair merged when its only group is completed/aborted (once paired, always one node)", async () => {
    const rows = [
      makeAgent("ceo", "CEO", null, "ceo"),
      makeAgent("owner", "Orchestrator", "ceo"),
      makeAgent("counterpart", "Orchestrator 2", "ceo"),
    ];
    // The pairGroups query no longer filters on status — this binding stands
    // for a group whose status is completed or aborted. The two agents stay
    // one org node, ready to pair again on the next issue.
    const svc = agentService(createDb(rows, [
      { ownerAgentId: "owner", counterpartAgentId: "counterpart" },
    ]));

    const tree = (await svc.orgForCompany("company-1")) as unknown as OrgTreeNode[];

    expect(collectIds(tree)).not.toContain("counterpart");
    expect(findNode(tree, "owner")!.pair).toMatchObject({ id: "counterpart" });
  });

  it("lets the NEWEST group decide the primary when an old group had the roles swapped", async () => {
    const rows = [
      makeAgent("x", "Agent X", null),
      makeAgent("y", "Agent Y", null),
    ];
    // createdAt DESC: the newest group has Y as owner; an older (e.g. aborted)
    // group from a previous issue had X as owner. The newest orientation wins,
    // so Y is the primary node and X rides along as `pair`.
    const svc = agentService(createDb(rows, [
      { ownerAgentId: "y", counterpartAgentId: "x" },
      { ownerAgentId: "x", counterpartAgentId: "y" },
    ]));

    const tree = (await svc.orgForCompany("company-1")) as unknown as OrgTreeNode[];

    expect(tree.map((node) => node.id)).toEqual(["y"]);
    expect(tree[0]!.pair).toMatchObject({ id: "x" });
  });

  it("skips the merge when the counterpart is not in the tree (e.g. terminated)", async () => {
    const rows = [makeAgent("owner", "Orchestrator", null)];
    const svc = agentService(createDb(rows, [
      { ownerAgentId: "owner", counterpartAgentId: "ghost" },
    ]));

    const tree = (await svc.orgForCompany("company-1")) as unknown as OrgTreeNode[];

    expect(tree.map((node) => node.id)).toEqual(["owner"]);
    expect(tree[0]).not.toHaveProperty("pair");
  });
});

describe("mergeMutualPairsForOrg (pure helper)", () => {
  it("re-points a manager reference at a removed counterpart from ANOTHER pair to that pair's primary", () => {
    // Two disjoint pairs; pair A's owner reports to pair B's counterpart.
    const rows = [
      makeAgent("a1", "A1", "b2"),
      makeAgent("a2", "A2", null),
      makeAgent("b1", "B1", null),
      makeAgent("b2", "B2", null),
    ];
    const { rows: merged, pairByPrimary } = mergeMutualPairsForOrg(rows, [
      { ownerAgentId: "a1", counterpartAgentId: "a2" },
      { ownerAgentId: "b1", counterpartAgentId: "b2" },
    ]);

    expect(pairByPrimary.get("a1")).toMatchObject({ id: "a2" });
    expect(pairByPrimary.get("b1")).toMatchObject({ id: "b2" });
    const a1 = merged.find((row) => row.id === "a1");
    // b2 was merged away → a1 now reports to b1 (pair B's primary).
    expect(a1?.reportsTo).toBe("b1");
    expect(merged.map((row) => row.id).sort()).toEqual(["a1", "b1"]);
  });

  it("returns the input rows untouched when there are no bindings", () => {
    const rows = [makeAgent("a", "A", null)];
    const result = mergeMutualPairsForOrg(rows, []);
    expect(result.rows).toBe(rows);
    expect(result.pairByPrimary.size).toBe(0);
  });
});

describe("latestBindingPerPair (pure helper)", () => {
  it("keeps only the first (newest) row per unordered pair, treating swapped roles as the same pair", () => {
    const newest = { ownerAgentId: "a", counterpartAgentId: "b" };
    const deduped = latestBindingPerPair([
      newest,
      { ownerAgentId: "b", counterpartAgentId: "a" }, // older, roles swapped
      { ownerAgentId: "a", counterpartAgentId: "b" }, // oldest
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toBe(newest);
  });

  it("keeps distinct pairs and half-open bindings as separate latest entries", () => {
    const deduped = latestBindingPerPair([
      { ownerAgentId: "a", counterpartAgentId: "b" },
      { ownerAgentId: "a", counterpartAgentId: "c" }, // different pair → kept
      { ownerAgentId: "a", counterpartAgentId: null }, // half-open → kept (marks `a` ambiguous downstream)
      { ownerAgentId: "a", counterpartAgentId: null }, // older duplicate half-open → dropped
    ]);
    expect(deduped).toEqual([
      { ownerAgentId: "a", counterpartAgentId: "b" },
      { ownerAgentId: "a", counterpartAgentId: "c" },
      { ownerAgentId: "a", counterpartAgentId: null },
    ]);
  });

  it("returns an empty list for no bindings", () => {
    expect(latestBindingPerPair([])).toEqual([]);
  });
});
