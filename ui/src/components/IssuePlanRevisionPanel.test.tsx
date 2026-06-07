// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuePlanRevisionPanel } from "./IssuePlanRevisionPanel";

// WC-188 / CP7: plan-revision affordance. Mirrors IssueDesignReviewPanel's
// harness (createRoot + act + QueryClientProvider) with the api + toast modules
// mocked so the affordance's submit path is exercised deterministically.

const requestPlanRevisionMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("../api/issues", () => ({
  issuesApi: {
    requestPlanRevision: (id: string, feedback: string) =>
      requestPlanRevisionMock(id, feedback),
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function click(el: Element | null | undefined) {
  act(() => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function type(el: Element | null | undefined, value: string) {
  // Drive React's onChange: set the value via the native setter (bypassing
  // React's value-tracking shim) then dispatch a bubbling input event.
  const input = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("IssuePlanRevisionPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    requestPlanRevisionMock
      .mockReset()
      .mockResolvedValue({ ok: true, comment: { id: "c-1" }, plannerAgentId: "planner-1" });
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
          <IssuePlanRevisionPanel issueId="issue-1" />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("renders the collapsed request-revision toggle by default", async () => {
    await mount();
    expect(container.querySelector('[data-testid="plan-revision-toggle"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="plan-revision-form"]')).toBeNull();
  });

  it("reveals the feedback form when the toggle is clicked", async () => {
    await mount();
    click(container.querySelector('[data-testid="plan-revision-toggle"]'));
    await flush();
    expect(container.querySelector('[data-testid="plan-revision-form"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="plan-revision-feedback"]')).toBeTruthy();
  });

  it("submits the trimmed feedback, calls the route, and shows a success toast", async () => {
    await mount();
    click(container.querySelector('[data-testid="plan-revision-toggle"]'));
    await flush();
    type(
      container.querySelector('[data-testid="plan-revision-feedback"]'),
      "  Tighten the acceptance criteria  ",
    );
    await flush();
    click(container.querySelector('[data-testid="plan-revision-submit"]'));
    await flush();

    expect(requestPlanRevisionMock).toHaveBeenCalledTimes(1);
    expect(requestPlanRevisionMock).toHaveBeenCalledWith(
      "issue-1",
      "Tighten the acceptance criteria",
    );
    expect(pushToastMock).toHaveBeenCalledTimes(1);
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success" }),
    );
    // On success the form collapses back to the toggle.
    expect(container.querySelector('[data-testid="plan-revision-form"]')).toBeNull();
  });

  it("disables submit while the feedback is empty and does not call the route", async () => {
    await mount();
    click(container.querySelector('[data-testid="plan-revision-toggle"]'));
    await flush();
    const submitBtn = container.querySelector(
      '[data-testid="plan-revision-submit"]',
    ) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    click(submitBtn);
    await flush();
    expect(requestPlanRevisionMock).not.toHaveBeenCalled();
    // Once non-blank feedback is entered, submit enables.
    type(container.querySelector('[data-testid="plan-revision-feedback"]'), "Add the empty state");
    await flush();
    expect(submitBtn.disabled).toBe(false);
  });

  it("surfaces an error toast when the route fails (e.g. no planner → 409)", async () => {
    requestPlanRevisionMock
      .mockReset()
      .mockRejectedValue(new Error("no planner-capable agent"));
    await mount();
    click(container.querySelector('[data-testid="plan-revision-toggle"]'));
    await flush();
    type(container.querySelector('[data-testid="plan-revision-feedback"]'), "Please revise");
    await flush();
    click(container.querySelector('[data-testid="plan-revision-submit"]'));
    await flush();

    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error", body: "no planner-capable agent" }),
    );
    // The form stays open on failure so the user can retry.
    expect(container.querySelector('[data-testid="plan-revision-form"]')).toBeTruthy();
  });
});
