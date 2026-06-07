// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlannerDraftBar, buildGrilledPrompt } from "./PlannerDraftBar";

const mockIssuesApi = vi.hoisted(() => ({
  draftFromPrompt: vi.fn(),
  draftGrill: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const GRILL_MODE_STORAGE_KEY = "workcell:planner-grill-mode";

function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });
  return result && typeof (result as Promise<void>).then === "function"
    ? (result as Promise<void>).then(() => undefined)
    : undefined;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function render(
  container: HTMLDivElement,
  props: Partial<Parameters<typeof PlannerDraftBar>[0]> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PlannerDraftBar
          companyId="company-1"
          hasPlannerCapableAgent
          isTrulyEmpty={false}
          {...props}
        />
      </QueryClientProvider>,
    );
  });
  return { root };
}

describe("buildGrilledPrompt", () => {
  it("appends only answered questions to the original prompt", () => {
    const out = buildGrilledPrompt("Add SSO", [
      { question: "Which IdPs?", recommendation: "Okta", rationale: "common", answer: "Okta + Google" },
      { question: "Self-serve?", recommendation: "no", rationale: "smaller", answer: "   " },
    ]);
    expect(out).toContain("Add SSO");
    expect(out).toContain("Clarifying answers:");
    expect(out).toContain("Q: Which IdPs?");
    expect(out).toContain("A: Okta + Google");
    // The blank answer is skipped.
    expect(out).not.toContain("Self-serve?");
  });

  it("returns the prompt unchanged when nothing is answered", () => {
    expect(buildGrilledPrompt("Add SSO", [])).toBe("Add SSO");
    expect(
      buildGrilledPrompt("Add SSO", [
        { question: "Q", recommendation: "r", rationale: "", answer: "" },
      ]),
    ).toBe("Add SSO");
  });
});

describe("PlannerDraftBar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.removeItem(GRILL_MODE_STORAGE_KEY);
    mockIssuesApi.draftFromPrompt.mockReset();
    mockIssuesApi.draftGrill.mockReset();
    mockIssuesApi.draftFromPrompt.mockResolvedValue({ id: "issue-1", identifier: "WC-1" });
    mockIssuesApi.draftGrill.mockResolvedValue({ questions: [] });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the grill toggle and persists its state to localStorage", () => {
    const { root } = render(container);

    const toggle = container.querySelector('[data-testid="planner-grill-toggle"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(GRILL_MODE_STORAGE_KEY)).toBe("1");

    act(() => root.unmount());

    // A fresh mount restores the persisted ON state.
    const remount = render(container);
    const restoredToggle = container.querySelector('[data-testid="planner-grill-toggle"]') as HTMLButtonElement;
    expect(restoredToggle.getAttribute("aria-pressed")).toBe("true");
    act(() => remount.root.unmount());
  });

  it("OFF path is unchanged: submitting calls draftFromPrompt and never grills", async () => {
    const { root } = render(container);

    const input = container.querySelector('[data-testid="planner-draft-submit"]')
      ? (container.querySelector("input[type=text]") as HTMLInputElement)
      : null;
    expect(input).not.toBeNull();
    setInputValue(input!, "Add a CSV export button");

    const submit = container.querySelector('[data-testid="planner-draft-submit"]') as HTMLButtonElement;
    click(submit);
    await flush();

    expect(mockIssuesApi.draftFromPrompt).toHaveBeenCalledWith("company-1", {
      prompt: "Add a CSV export button",
    });
    expect(mockIssuesApi.draftGrill).not.toHaveBeenCalled();
    // No questions panel appears in the OFF path.
    expect(container.querySelector('[data-testid="planner-grill-questions"]')).toBeNull();

    act(() => root.unmount());
  });

  it("ON path: grill submit renders questions with recommendations pre-filled + rationale", async () => {
    mockIssuesApi.draftGrill.mockResolvedValue({
      questions: [
        { question: "Which identity providers?", recommendation: "Okta + Google", rationale: "Most common." },
        { question: "Self-serve onboarding?", recommendation: "Admin-only first", rationale: "Smaller surface." },
      ],
    });

    const { root } = render(container);

    const toggle = container.querySelector('[data-testid="planner-grill-toggle"]') as HTMLButtonElement;
    click(toggle);

    const input = container.querySelector("input[type=text]") as HTMLInputElement;
    setInputValue(input, "Add SSO support");

    const submit = container.querySelector('[data-testid="planner-draft-submit"]') as HTMLButtonElement;
    click(submit);
    await flush();

    await waitForAssertion(() => {
      expect(mockIssuesApi.draftGrill).toHaveBeenCalledWith("company-1", { prompt: "Add SSO support" });
      expect(container.querySelector('[data-testid="planner-grill-questions"]')).not.toBeNull();
    });

    // The recommended answers are pre-filled into editable inputs.
    const answer0 = container.querySelector('[data-testid="planner-grill-answer-0"]') as HTMLInputElement;
    const answer1 = container.querySelector('[data-testid="planner-grill-answer-1"]') as HTMLInputElement;
    expect(answer0.value).toBe("Okta + Google");
    expect(answer1.value).toBe("Admin-only first");
    // The rationale shows as helper text.
    expect(container.textContent).toContain("Most common.");
    expect(container.textContent).toContain("Smaller surface.");
    // Drafting was NOT triggered by grilling.
    expect(mockIssuesApi.draftFromPrompt).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("'draft with these answers' appends the resolved Q&A and calls the normal draft", async () => {
    mockIssuesApi.draftGrill.mockResolvedValue({
      questions: [
        { question: "Which identity providers?", recommendation: "Okta + Google", rationale: "Most common." },
      ],
    });

    const { root } = render(container);
    click(container.querySelector('[data-testid="planner-grill-toggle"]')!);
    setInputValue(container.querySelector("input[type=text]") as HTMLInputElement, "Add SSO support");
    click(container.querySelector('[data-testid="planner-draft-submit"]')!);
    await flush();

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="planner-grill-answer-0"]')).not.toBeNull();
    });

    // Edit the recommended answer before drafting.
    setInputValue(
      container.querySelector('[data-testid="planner-grill-answer-0"]') as HTMLInputElement,
      "Okta only",
    );

    click(container.querySelector('[data-testid="planner-grill-draft-with-answers"]')!);
    await flush();

    expect(mockIssuesApi.draftFromPrompt).toHaveBeenCalledTimes(1);
    const [, payload] = mockIssuesApi.draftFromPrompt.mock.calls[0];
    expect(payload.prompt).toContain("Add SSO support");
    expect(payload.prompt).toContain("Clarifying answers:");
    expect(payload.prompt).toContain("Q: Which identity providers?");
    expect(payload.prompt).toContain("A: Okta only");

    act(() => root.unmount());
  });

  it("'skip and draft' drafts the original prompt without any answers appended", async () => {
    mockIssuesApi.draftGrill.mockResolvedValue({
      questions: [{ question: "Q?", recommendation: "R", rationale: "Why." }],
    });

    const { root } = render(container);
    click(container.querySelector('[data-testid="planner-grill-toggle"]')!);
    setInputValue(container.querySelector("input[type=text]") as HTMLInputElement, "Add exports");
    click(container.querySelector('[data-testid="planner-draft-submit"]')!);
    await flush();

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="planner-grill-skip"]')).not.toBeNull();
    });

    click(container.querySelector('[data-testid="planner-grill-skip"]')!);
    await flush();

    expect(mockIssuesApi.draftFromPrompt).toHaveBeenCalledWith("company-1", { prompt: "Add exports" });

    act(() => root.unmount());
  });
});
