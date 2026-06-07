// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue, IssueStatus } from "@workcell/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanBoard, resolveKanbanTargetStatus } from "./KanbanBoard";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    disableIssueQuicklook?: boolean;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(index: number, status: IssueStatus): Issue {
  return {
    id: `issue-${status}-${index}`,
    identifier: `PAP-${index}`,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Issue ${index}`,
    description: null,
    status,
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: index === 1 ? "agent-1" : null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: index,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-05T00:00:00.000Z"),
    updatedAt: new Date("2026-05-05T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
  };
}

function createIssues(count: number, status: IssueStatus): Issue[] {
  return Array.from({ length: count }, (_, index) => createIssue(index + 1, status));
}

function renderBoard(
  props: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] },
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const render = (nextProps: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] }) => {
    act(() => {
      root.render(
        <KanbanBoard
          agents={[{ id: "agent-1", name: "Codex" }]}
          liveIssueIds={new Set(["issue-todo-1"])}
          onUpdateIssue={vi.fn()}
          {...nextProps}
        />,
      );
    });
  };

  render(props);

  return { container, root, render };
}

describe("KanbanBoard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("limits visible cards and reveals more cards per column", () => {
    const { container } = renderBoard({
      issues: createIssues(60, "todo"),
      compactCards: true,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    expect(container.textContent).toContain("Showing 50 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 50");
    expect(container.textContent).not.toContain("Issue 51");

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");
    expect(container.textContent).not.toContain("Show 10 more");
  });

  it("resets visible counts when the column page size changes", () => {
    const issues = createIssues(60, "todo");
    const { container, render } = renderBoard({
      issues,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");

    render({
      issues,
      initialVisibleCount: 10,
      revealIncrement: 10,
    });

    expect(container.textContent).toContain("Showing 10 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 10");
    expect(container.textContent).not.toContain("Issue 11");
  });

  it("renders collapsed statuses as rails without cards", () => {
    const { container } = renderBoard({
      issues: createIssues(3, "done"),
      collapsedStatuses: ["done"],
    });

    expect(container.textContent).toContain("Done");
    expect(container.textContent).toContain("3");
    expect(container.textContent).not.toContain("Issue 1");
  });

  it("keeps core issue signals in compact cards", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "todo"),
      compactCards: true,
    });

    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Issue 1");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Live");
  });

  it("resolves drop targets from status rails and cards", () => {
    const issues = [
      createIssue(1, "todo"),
      createIssue(2, "blocked"),
    ];

    expect(resolveKanbanTargetStatus("done", issues)).toBe("done");
    expect(resolveKanbanTargetStatus("issue-blocked-2", issues)).toBe("blocked");
    expect(resolveKanbanTargetStatus("missing", issues)).toBeNull();
  });

  it("renders the owner-role chip from the assignee agent's role (WC-8)", () => {
    const issues = [createIssue(1, "todo")];
    const { container } = renderBoard({
      issues,
      // Issue 1 has assigneeAgentId "agent-1" per createIssue() — provide a role.
      agents: [{ id: "agent-1", name: "Codex", role: "qa" }],
    });

    // The shared AGENT_ROLE_LABELS maps "qa" → "QA".
    const chip = container.querySelector('[aria-label="Owner role: QA"]');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe("QA");
  });

  it("omits the chip when the agent has no role on it", () => {
    const issues = [createIssue(1, "todo")];
    const { container } = renderBoard({
      issues,
      // Backward-compatible callers that only pass id+name keep working — chip
      // is silently absent rather than throwing.
      agents: [{ id: "agent-1", name: "Codex" }],
    });

    expect(container.querySelector('[aria-label^="Owner role:"]')).toBeNull();
    // Identity (assignee name) still renders unaffected.
    expect(container.textContent).toContain("Codex");
  });

  it("falls back to the raw role string for unknown role values (forward-compat)", () => {
    const issues = [createIssue(1, "todo")];
    const { container } = renderBoard({
      issues,
      agents: [{ id: "agent-1", name: "Codex", role: "growth_hacker" }],
    });

    // Unknown role isn't in AGENT_ROLE_LABELS, so we surface the raw string.
    const chip = container.querySelector('[aria-label="Owner role: growth_hacker"]');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe("growth_hacker");
  });

  it("renders the proof chip when issue.hasProof === true (WC-9)", () => {
    const issue = { ...createIssue(1, "todo"), hasProof: true };
    const { container } = renderBoard({
      issues: [issue],
      agents: [{ id: "agent-1", name: "Codex" }],
    });

    const chip = container.querySelector('[aria-label="Proof attached"]');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe("Proof");
  });

  it("omits the proof chip when hasProof is false or undefined (positive-only chip)", () => {
    const noProof = { ...createIssue(1, "todo"), hasProof: false };
    const { container: containerFalse } = renderBoard({
      issues: [noProof],
      agents: [{ id: "agent-1", name: "Codex" }],
    });
    expect(containerFalse.querySelector('[aria-label="Proof attached"]')).toBeNull();

    // Without hasProof set at all (e.g. detail/legacy paths), still no chip.
    const unknownProof = createIssue(1, "todo");
    const { container: containerUndefined } = renderBoard({
      issues: [unknownProof],
      agents: [{ id: "agent-1", name: "Codex" }],
    });
    expect(containerUndefined.querySelector('[aria-label="Proof attached"]')).toBeNull();
  });

  it("renders a sub-$100 usage chip with two decimals when totalCostCents > 0 (WC-11)", () => {
    // 4287 cents = $42.87 — exactly the kind of cost a card should surface.
    const issue = { ...createIssue(1, "todo"), totalCostCents: 4287 };
    const { container } = renderBoard({
      issues: [issue],
      agents: [{ id: "agent-1", name: "Codex" }],
    });

    const chip = container.querySelector('[aria-label="Cost $42.87"]');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe("$42.87");
  });

  it("rounds the usage chip to whole dollars at $100+ (compact)", () => {
    // 12_345 cents = $123.45 — over the $100 threshold, so we round.
    const issue = { ...createIssue(1, "todo"), totalCostCents: 12_345 };
    const { container } = renderBoard({
      issues: [issue],
      agents: [{ id: "agent-1", name: "Codex" }],
    });

    const chip = container.querySelector('[aria-label="Cost $123"]');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe("$123");
  });

  it("omits the usage chip when totalCostCents is 0 or undefined (positive-only)", () => {
    const zero = { ...createIssue(1, "todo"), totalCostCents: 0 };
    const { container: containerZero } = renderBoard({
      issues: [zero],
      agents: [{ id: "agent-1", name: "Codex" }],
    });
    expect(containerZero.querySelector('[aria-label^="Cost "]')).toBeNull();

    const unknown = createIssue(1, "todo");
    const { container: containerUndefined } = renderBoard({
      issues: [unknown],
      agents: [{ id: "agent-1", name: "Codex" }],
    });
    expect(containerUndefined.querySelector('[aria-label^="Cost "]')).toBeNull();
  });

  it("renders the compound-origin chip when originKind === 'compound_followup' (WC-18)", () => {
    const issue = { ...createIssue(1, "backlog"), originKind: "compound_followup" as const };
    const { container } = renderBoard({
      issues: [issue],
      agents: [{ id: "agent-1", name: "Codex" }],
    });

    const chip = container.querySelector('[aria-label="From compound checklist"]');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe("Compound");
  });

  it("omits the compound-origin chip for other origin kinds and absent originKind (positive-only)", () => {
    const recovery = { ...createIssue(1, "todo"), originKind: "stale_active_run_evaluation" as const };
    const { container: c1 } = renderBoard({
      issues: [recovery],
      agents: [{ id: "agent-1", name: "Codex" }],
    });
    expect(c1.querySelector('[aria-label="From compound checklist"]')).toBeNull();

    const plain = createIssue(1, "todo");
    const { container: c2 } = renderBoard({
      issues: [plain],
      agents: [{ id: "agent-1", name: "Codex" }],
    });
    expect(c2.querySelector('[aria-label="From compound checklist"]')).toBeNull();
  });

  it("renders the pair-mode chip when workOwnerKind === 'pair' (WC-34)", () => {
    const issue = { ...createIssue(1, "in_progress"), workOwnerKind: "pair" as const };
    const { container } = renderBoard({
      issues: [issue],
      agents: [{ id: "agent-1", name: "Codex" }],
    });
    const chip = container.querySelector('[aria-label="Pair mode"]');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe("Pair");
  });

  it("omits the pair-mode chip when workOwnerKind is single or absent (positive-only)", () => {
    const single = { ...createIssue(1, "todo"), workOwnerKind: "single" as const };
    const { container: c1 } = renderBoard({
      issues: [single],
      agents: [{ id: "agent-1", name: "Codex" }],
    });
    expect(c1.querySelector('[aria-label="Pair mode"]')).toBeNull();

    const absent = createIssue(1, "todo");
    const { container: c2 } = renderBoard({
      issues: [absent],
      agents: [{ id: "agent-1", name: "Codex" }],
    });
    expect(c2.querySelector('[aria-label="Pair mode"]')).toBeNull();
  });
});
