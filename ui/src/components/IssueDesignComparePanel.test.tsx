// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueWorkProduct } from "@workcell/shared";
import { IssueDesignComparePanel } from "./IssueDesignComparePanel";

// WC-183c / (b)③: the 복각 side-by-side. Mirrors IssueDesignReviewPanel's harness
// (createRoot + act + QueryClientProvider) with `../api/issues` mocked so the
// panel's null-guard and the two-column compare render deterministically.

const listWorkProductsMock = vi.hoisted(() => vi.fn());

vi.mock("../api/issues", () => ({
  issuesApi: {
    listWorkProducts: (id: string) => listWorkProductsMock(id),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function design(overrides: Partial<IssueWorkProduct>): IssueWorkProduct {
  return {
    id: "wp-1",
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    // "design" is an open-enum text value stored in issue_work_products.type;
    // it is intentionally outside the narrow IssueWorkProductType union, so cast.
    type: "design" as IssueWorkProduct["type"],
    provider: "workcell",
    externalId: null,
    screenKey: null,
    screenName: null,
    title: "Login screen design",
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function designSystem(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return design({
    id: "ds-1",
    title: "Extracted design system",
    url: "data:text/html,<html><body>system</body></html>",
    metadata: {
      kind: "design_system",
      tokens: { colors: ["#111", "#222", "#333"], fontSizes: ["12px", "14px"] },
    } as IssueWorkProduct["metadata"],
    ...overrides,
  });
}

async function flush() {
  // Drain react-query's async settle + React's effect/state flushes.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("IssueDesignComparePanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    listWorkProductsMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function mount() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDesignComparePanel issueId="issue-1" />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("renders nothing when there is no design-system artifact", async () => {
    // Ordinary designs (and a non-design proof) — no design_system metadata.
    listWorkProductsMock.mockResolvedValue([
      design({ id: "d1", isPrimary: true, title: "Plain design" }),
      design({ id: "proof-1", type: "proof", title: "Proof" }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-compare-panel"]')).toBeNull();
  });

  it("renders nothing when there are no work products at all", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    await mount();
    expect(container.querySelector('[data-testid="design-compare-panel"]')).toBeNull();
  });

  it("renders both previews when a design system and a reproduced screen exist", async () => {
    listWorkProductsMock.mockResolvedValue([
      designSystem(),
      design({
        id: "repro-1",
        isPrimary: true,
        title: "Reproduced login",
        url: "data:text/html,<html><body>repro</body></html>",
      }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-compare-panel"]')).toBeTruthy();
    // Both sides render with their titles.
    expect(container.querySelector('[data-testid="design-compare-system"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-compare-reproduced"]')).toBeTruthy();
    expect(container.textContent).toContain("Extracted design system");
    expect(container.textContent).toContain("Reproduced login");
    // Two preview iframes (system + reproduced); no empty state.
    expect(
      container.querySelector('[data-testid="design-compare-system-preview"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="design-compare-reproduced-preview"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="design-compare-reproduced-empty"]'),
    ).toBeNull();
    expect(container.querySelectorAll("iframe").length).toBe(2);
  });

  it("shows the empty reproduced state when a design system exists but no reproduced screen", async () => {
    listWorkProductsMock.mockResolvedValue([designSystem()]);
    await mount();
    expect(container.querySelector('[data-testid="design-compare-panel"]')).toBeTruthy();
    // Design-system side still renders its preview.
    expect(
      container.querySelector('[data-testid="design-compare-system-preview"]'),
    ).toBeTruthy();
    // Reproduced side is the empty state, with no reproduced preview iframe.
    expect(
      container.querySelector('[data-testid="design-compare-reproduced-empty"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="design-compare-reproduced-preview"]'),
    ).toBeNull();
    // Locale-independent: assert the empty-state node carries copy (its exact
    // string is the i18n defaultValue, resolved per active locale).
    expect(
      container.querySelector('[data-testid="design-compare-reproduced-empty"]')?.textContent
        ?.trim().length,
    ).toBeGreaterThan(0);
  });
});
