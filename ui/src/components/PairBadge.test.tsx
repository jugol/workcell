// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairBadge } from "./PairBadge";
import type { PairBindingForAgent } from "../lib/pair-bindings";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function pairFor(overrides: Partial<PairBindingForAgent> = {}): PairBindingForAgent {
  return {
    pairGroupId: "pg-1",
    issueId: "issue-1",
    issueIdentifier: "WC-12",
    issueTitle: "Pair candidate",
    counterpartAgentId: "agent-2",
    counterpartAgentName: "Engineer",
    ...overrides,
  };
}

describe("PairBadge (WC-189 agent-side pair marker)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(node: React.ReactNode) {
    root = createRoot(container);
    act(() => {
      root.render(node);
    });
  }

  it("shows a pair badge naming the counterpart for an agent in an active pair", () => {
    render(<PairBadge bindings={[pairFor()]} />);

    const badge = container.querySelector('[data-testid="pair-badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("Engineer");
    // Links to the counterpart agent...
    expect(badge!.getAttribute("href")).toBe("/agents/agent-2");
    // ...and names the counterpart + issue ref in the title.
    expect(badge!.getAttribute("title")).toBe("Paired with Engineer on WC-12");
  });

  it("renders no pair marker when the agent has no bindings (undefined)", () => {
    render(<PairBadge bindings={undefined} />);
    expect(container.querySelector('[data-testid="pair-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="pair-badge-group"]')).toBeNull();
  });

  it("renders no pair marker when the agent has an empty binding list", () => {
    render(<PairBadge bindings={[]} />);
    expect(container.querySelector('[data-testid="pair-badge"]')).toBeNull();
  });

  it("shows the short label but keeps the full title in compact (org chart) mode", () => {
    render(<PairBadge bindings={[pairFor()]} compact />);
    const badge = container.querySelector('[data-testid="pair-badge"]');
    expect(badge!.textContent).toContain("Pair");
    expect(badge!.textContent).not.toContain("Engineer");
    expect(badge!.getAttribute("title")).toBe("Paired with Engineer on WC-12");
  });

  it("renders one badge per binding when paired on multiple issues", () => {
    render(
      <PairBadge
        bindings={[
          pairFor({ pairGroupId: "pg-1", issueIdentifier: "WC-1" }),
          pairFor({
            pairGroupId: "pg-2",
            issueIdentifier: "WC-2",
            counterpartAgentId: "agent-3",
            counterpartAgentName: "Planner",
          }),
        ]}
      />,
    );
    const badges = container.querySelectorAll('[data-testid="pair-badge"]');
    expect(badges).toHaveLength(2);
  });

  it("degrades to a static (non-link) pill when the counterpart is unassigned", () => {
    render(
      <PairBadge
        bindings={[pairFor({ counterpartAgentId: null, counterpartAgentName: null })]}
      />,
    );
    const badge = container.querySelector('[data-testid="pair-badge"]');
    expect(badge).not.toBeNull();
    // No link target when the counterpart id is unknown.
    expect(badge!.getAttribute("href")).toBeNull();
    expect(badge!.tagName.toLowerCase()).not.toBe("a");
  });
});
