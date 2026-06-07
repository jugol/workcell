// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueWorkProduct } from "@workcell/shared";
import { IssueDesignReviewPanel } from "./IssueDesignReviewPanel";

// WC-182 / D22: design-review gate UI. Mirrors PairSetupPanel's harness
// (createRoot + act + QueryClientProvider) with the api + toast modules mocked
// so the panel's states and actions are exercised deterministically.

const listWorkProductsMock = vi.hoisted(() => vi.fn());
const submitMock = vi.hoisted(() => vi.fn());
const approveMock = vi.hoisted(() => vi.fn());
const requestChangesMock = vi.hoisted(() => vi.fn());
const createDesignArtifactMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("../api/issues", () => ({
  issuesApi: {
    listWorkProducts: (id: string) => listWorkProductsMock(id),
    submitDesignReview: (id: string) => submitMock(id),
    approveDesignReview: (id: string) => approveMock(id),
    requestDesignChanges: (id: string, reason?: string) => requestChangesMock(id, reason),
    createDesignArtifact: (id: string, data: unknown) => createDesignArtifactMock(id, data),
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
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

function click(el: Element | null | undefined) {
  act(() => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function type(el: Element | null | undefined, value: string) {
  // Drive React's onChange: set the value via the native setter (bypassing
  // React's value-tracking shim) then dispatch a bubbling input event.
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush() {
  // Drain react-query's async settle + React's effect/state flushes. A few
  // macrotask ticks inside act() reliably move useQuery out of its loading
  // state with the mocked (already-resolved) api promise.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("IssueDesignReviewPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    listWorkProductsMock.mockReset();
    submitMock.mockReset().mockResolvedValue(design({ reviewState: "needs_board_review", isPrimary: true }));
    approveMock.mockReset().mockResolvedValue(design({ reviewState: "approved", isPrimary: true }));
    requestChangesMock.mockReset().mockResolvedValue(design({ reviewState: "changes_requested", isPrimary: true }));
    createDesignArtifactMock
      .mockReset()
      .mockResolvedValue(design({ id: "wp-new", isPrimary: true, reviewState: "none" }));
    pushToastMock.mockReset();
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
          <IssueDesignReviewPanel issueId="issue-1" />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("renders the empty state when there are no design work products", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ id: "proof-1", type: "proof", title: "Proof" }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-review-authoritative"]')).toBeNull();
  });

  it("shows submit on an authoritative design in reviewState none", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ isPrimary: true, reviewState: "none" }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-authoritative"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-review-submit"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-review-approve"]')).toBeNull();
  });

  it("shows approve + request-changes when the authoritative design needs board review", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ isPrimary: true, reviewState: "needs_board_review" }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-approve"]')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="design-review-request-changes-toggle"]'),
    ).toBeTruthy();
  });

  it("approve calls the API and invalidates the work-products query", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ isPrimary: true, reviewState: "needs_board_review" }),
    ]);
    await mount();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    click(container.querySelector('[data-testid="design-review-approve"]'));
    await flush();
    expect(approveMock).toHaveBeenCalledTimes(1);
    expect(approveMock).toHaveBeenCalledWith("wp-1");
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["issues", "work-products", "issue-1"],
    });
  });

  it("renders the approved source-of-truth treatment when approved", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ isPrimary: true, reviewState: "approved" }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-approved"]')).toBeTruthy();
    // A quieter "request changes" reopen action remains available.
    expect(container.querySelector('[data-testid="design-review-reopen"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-review-approve"]')).toBeNull();
  });

  it("lists design candidates with a designate action when none is authoritative", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ id: "d1", isPrimary: false, reviewState: "none", title: "Variant A" }),
      design({ id: "d2", isPrimary: false, reviewState: "none", title: "Variant B" }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-candidates"]')).toBeTruthy();
    const designate = container.querySelector('[data-testid="design-review-designate-d1"]');
    expect(designate).toBeTruthy();
    click(designate);
    await flush();
    expect(submitMock).toHaveBeenCalledWith("d1");
  });

  it("shows the attach-design button in the empty state", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-review-attach-toggle"]')).toBeTruthy();
    // The form is collapsed until the toggle is clicked.
    expect(container.querySelector('[data-testid="design-review-attach-form"]')).toBeNull();
  });

  it("attaching a title-only design calls createDesignArtifact with isPrimary and invalidates", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    await mount();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    click(container.querySelector('[data-testid="design-review-attach-toggle"]'));
    await flush();
    type(container.querySelector('[data-testid="design-review-attach-title"]'), "Login screen v2");
    await flush();
    click(container.querySelector('[data-testid="design-review-attach-submit"]'));
    await flush();
    expect(createDesignArtifactMock).toHaveBeenCalledTimes(1);
    expect(createDesignArtifactMock).toHaveBeenCalledWith("issue-1", {
      title: "Login screen v2",
      url: undefined,
      isPrimary: true,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["issues", "work-products", "issue-1"],
    });
  });

  it("attaching with a url passes the trimmed url through", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    await mount();
    click(container.querySelector('[data-testid="design-review-attach-toggle"]'));
    await flush();
    type(container.querySelector('[data-testid="design-review-attach-title"]'), "Variant A");
    type(
      container.querySelector('[data-testid="design-review-attach-url"]'),
      "https://figma.com/file/abc",
    );
    await flush();
    click(container.querySelector('[data-testid="design-review-attach-submit"]'));
    await flush();
    expect(createDesignArtifactMock).toHaveBeenCalledWith("issue-1", {
      title: "Variant A",
      url: "https://figma.com/file/abc",
      isPrimary: true,
    });
  });

  it("disables the attach submit while the title is empty", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    await mount();
    click(container.querySelector('[data-testid="design-review-attach-toggle"]'));
    await flush();
    const submitBtn = container.querySelector(
      '[data-testid="design-review-attach-submit"]',
    ) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    // Clicking the disabled submit must not fire the mutation.
    click(submitBtn);
    await flush();
    expect(createDesignArtifactMock).not.toHaveBeenCalled();
    // Once a non-blank title is entered, the submit enables.
    type(container.querySelector('[data-testid="design-review-attach-title"]'), "Has title");
    await flush();
    expect(submitBtn.disabled).toBe(false);
  });

  // WC-182f / D22: the design gate drives development. While the source-of-truth
  // design is not yet approved, the panel shows a subtle hold note mirroring the
  // agent-facing HOLD directive injected into the heartbeat context.
  it("shows the development-hold note while the authoritative design needs board review", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ isPrimary: true, reviewState: "needs_board_review" }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-hold"]')).toBeTruthy();
  });

  it("shows the development-hold note while the authoritative design has changes requested", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ isPrimary: true, reviewState: "changes_requested" }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-hold"]')).toBeTruthy();
  });

  it("does not show the development-hold note when the authoritative design is approved", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ isPrimary: true, reviewState: "approved" }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-hold"]')).toBeNull();
    // The approved treatment still renders.
    expect(container.querySelector('[data-testid="design-review-approved"]')).toBeTruthy();
  });

  it("does not show the development-hold note for an authoritative design in reviewState none", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ isPrimary: true, reviewState: "none" }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-hold"]')).toBeNull();
  });

  it("does not show the development-hold note in the empty state", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-hold"]')).toBeNull();
  });
});
