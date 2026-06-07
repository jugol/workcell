// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairSetupPanel } from "./PairSetupPanel";

const createMock = vi.hoisted(() =>
  vi.fn(async (_issueId: string, _data: unknown) => ({ group: { id: "g1" } })),
);
vi.mock("../api/pair-groups", () => ({
  pairGroupsApi: { create: (issueId: string, data: unknown) => createMock(issueId, data) },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agents = [
  { id: "a1", name: "Alpha", status: "active" },
  { id: "a2", name: "Beta", status: "active" },
  { id: "term", name: "Gone", status: "terminated" },
];

function setSelectValue(sel: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(sel, value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function click(el: Element | null | undefined) {
  act(() => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("PairSetupPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    createMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function mount(props: Partial<React.ComponentProps<typeof PairSetupPanel>> = {}) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <PairSetupPanel issueId="issue-1" agents={agents} {...props} />
        </QueryClientProvider>,
      );
    });
  }

  it("starts collapsed as a discoverable CTA", () => {
    mount();
    expect(container.querySelector('[data-testid="pair-setup-cta"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pair-setup-panel"]')).toBeNull();
  });

  it("starts expanded when defaultOpen is set (WC-180 deep-link from New Issue)", () => {
    mount({ defaultOpen: true });
    expect(container.querySelector('[data-testid="pair-setup-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pair-setup-cta"]')).toBeNull();
  });

  it("expands reactively when defaultOpen flips on while mounted (WC-185 assignee deep-link)", () => {
    // Mounted collapsed, then the assignee picker's "Pair" choice flips the
    // ?pair=1 deep-link on — the already-mounted panel must expand.
    mount({ defaultOpen: false });
    expect(container.querySelector('[data-testid="pair-setup-panel"]')).toBeNull();
    mount({ defaultOpen: true });
    expect(container.querySelector('[data-testid="pair-setup-panel"]')).toBeTruthy();
  });

  it("expands to the form and excludes terminated agents from the pickers", () => {
    mount();
    click(container.querySelector('[data-testid="pair-setup-cta"]'));
    expect(container.querySelector('[data-testid="pair-setup-panel"]')).toBeTruthy();
    const optionLabels = Array.from(container.querySelectorAll("option")).map((o) => o.textContent);
    expect(optionLabels).toContain("Alpha");
    expect(optionLabels).toContain("Beta");
    expect(optionLabels).not.toContain("Gone");
  });

  it("creates a pair group with the two chosen agents", async () => {
    mount({ defaultOwnerAgentId: "a1" });
    click(container.querySelector('[data-testid="pair-setup-cta"]'));
    const selects = container.querySelectorAll("select");
    setSelectValue(selects[1] as HTMLSelectElement, "a2"); // counterpart
    const submit = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Start pair collaboration"),
    );
    click(submit);
    await act(async () => {
      await Promise.resolve();
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith("issue-1", {
      ownerAgentId: "a1",
      counterpartAgentId: "a2",
      maxRounds: expect.any(Number),
    });
  });

  it("does not create when a counterpart is not chosen", () => {
    mount({ defaultOwnerAgentId: "a1" });
    click(container.querySelector('[data-testid="pair-setup-cta"]'));
    const submit = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Start pair collaboration"),
    );
    click(submit);
    expect(createMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Pick both agents.");
  });
});
