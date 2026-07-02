// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { DeliberationPanel } from "./DeliberationPanel";

// WC-210: the panel renders MarkdownBody for turn content + finalOutput.
// MarkdownBody pulls in ThemeContext / the router / mermaid — out of scope for
// these tests — so stub it to a transparent passthrough that keeps the text in
// the DOM (so the finalOutput assertion still holds).
vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => (
    <div data-testid="markdown-body">{children}</div>
  ),
}));

// Mock the agents api the panel calls. Each test sets the mock behaviour.
const startDeliberation = vi.hoisted(() => vi.fn());
const listDeliberations = vi.hoisted(() => vi.fn());
const getDeliberation = vi.hoisted(() => vi.fn());
vi.mock("../api/agents", () => ({
  agentsApi: {
    startDeliberation: (...args: unknown[]) => startDeliberation(...args),
    listDeliberations: (...args: unknown[]) => listDeliberations(...args),
    getDeliberation: (...args: unknown[]) => getDeliberation(...args),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setInputValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: Element | null | undefined) {
  act(() => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function flush() {
  // Drain microtasks AND a macrotask so react-query's async queries settle and
  // their resulting state updates flush inside act().
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

// A completed run with 3 turns: A propose → B revise → A accept.
const completedRun = {
  id: "run-1",
  companyId: "co-1",
  agentId: "agent-1",
  task: "Design the idle-reward screen",
  status: "completed" as const,
  acceptedBy: "A" as const,
  rounds: 2,
  finalOutput: "FINAL: ship the rounded reward card.",
  totalCostCents: 30,
  error: null,
  maxRounds: 4,
  brainA: { adapter: null, model: null },
  brainB: { adapter: null, model: null },
  createdAt: "2026-06-05T00:00:00.000Z",
  completedAt: "2026-06-05T00:05:00.000Z",
};

const completedTurns = [
  {
    id: "t1",
    runId: "run-1",
    round: 0,
    brain: "A" as const,
    action: "propose" as const,
    content: "Draft: a plain reward list.",
    feedback: null,
    costCents: 10,
    createdAt: "2026-06-05T00:01:00.000Z",
  },
  {
    id: "t2",
    runId: "run-1",
    round: 1,
    brain: "B" as const,
    action: "revise" as const,
    content: "Revision: use a rounded card with confetti.",
    feedback: "Plain list is dull; cards read better.",
    costCents: 12,
    createdAt: "2026-06-05T00:02:00.000Z",
  },
  {
    id: "t3",
    runId: "run-1",
    round: 2,
    brain: "A" as const,
    action: "accept" as const,
    content: "Agreed — the rounded card is the final answer.",
    feedback: null,
    costCents: 8,
    createdAt: "2026-06-05T00:03:00.000Z",
  },
];

describe("DeliberationPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    startDeliberation.mockReset();
    listDeliberations.mockReset();
    getDeliberation.mockReset();
    listDeliberations.mockResolvedValue({ runs: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function mount(props: Partial<React.ComponentProps<typeof DeliberationPanel>> = {}) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <DeliberationPanel agentId="agent-1" companyId="co-1" {...props} />
        </QueryClientProvider>,
      );
    });
  }

  it("renders a completed run's timeline: brain badges, actions, finalOutput, acceptedBy", async () => {
    // Seed a past run so clicking it loads the completed detail.
    listDeliberations.mockResolvedValue({ runs: [completedRun] });
    getDeliberation.mockResolvedValue({ run: completedRun, turns: completedTurns });

    mount();
    await flush();

    // Click the past-run row → loads the detail timeline.
    const pastRun = container.querySelector('[data-testid="deliberation-past-run"]');
    expect(pastRun).toBeTruthy();
    click(pastRun);
    await flush();

    // The timeline renders one row per turn.
    const turns = container.querySelectorAll('[data-testid="deliberation-turn"]');
    expect(turns.length).toBe(3);

    // Brain badges: A, B, A (data-brain attribute proves which mind).
    const brains = Array.from(
      container.querySelectorAll('[data-testid="deliberation-brain-badge"]'),
    ).map((el) => el.getAttribute("data-brain"));
    expect(brains).toContain("A");
    expect(brains).toContain("B");

    // Action badges: propose, revise, accept.
    const actions = Array.from(
      container.querySelectorAll('[data-testid="deliberation-action-badge"]'),
    ).map((el) => el.getAttribute("data-action"));
    expect(actions).toEqual(expect.arrayContaining(["propose", "revise", "accept"]));

    // Run status = completed; acceptedBy surfaced; rounds + total cost shown.
    expect(
      container.querySelector('[data-testid="deliberation-run-status"]')?.getAttribute("data-status"),
    ).toBe("completed");
    expect(container.querySelector('[data-testid="deliberation-accepted-by"]')?.textContent).toContain("A");

    // The agreed final output is rendered.
    const finalOutput = container.querySelector('[data-testid="deliberation-final-output"]');
    expect(finalOutput).toBeTruthy();
    expect(finalOutput?.textContent).toContain("ship the rounded reward card");

    // The revise turn shows its reviewer feedback.
    expect(container.querySelector('[data-testid="deliberation-turn-feedback"]')?.textContent).toContain(
      "Plain list is dull",
    );
  });

  it("submits the task via the run form → calls startDeliberation, then polls the new run", async () => {
    startDeliberation.mockResolvedValue({ runId: "run-1", status: "running" });
    getDeliberation.mockResolvedValue({ run: completedRun, turns: completedTurns });

    mount();
    await flush();

    const taskInput = container.querySelector(
      '[data-testid="deliberation-task-input"]',
    ) as HTMLTextAreaElement;
    expect(taskInput).toBeTruthy();
    setInputValue(taskInput, "Design the idle-reward screen");

    const maxRounds = container.querySelector(
      '[data-testid="deliberation-max-rounds-input"]',
    ) as HTMLInputElement;
    setInputValue(maxRounds, "3");

    click(container.querySelector('[data-testid="deliberation-submit"]'));
    await flush();

    expect(startDeliberation).toHaveBeenCalledTimes(1);
    expect(startDeliberation).toHaveBeenCalledWith(
      "agent-1",
      { task: "Design the idle-reward screen", maxRoundsOverride: 3 },
      "co-1",
    );

    // After the 202, the panel polls getDeliberation for the returned runId and
    // renders its timeline.
    await flush();
    expect(getDeliberation).toHaveBeenCalledWith("agent-1", "run-1", "co-1");
    expect(container.querySelector('[data-testid="deliberation-run-timeline"]')).toBeTruthy();
  });

  it("does not submit when the task is empty", async () => {
    mount();
    await flush();
    // Submit button is disabled with an empty task; clicking does nothing.
    const submit = container.querySelector('[data-testid="deliberation-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    click(submit);
    await flush();
    expect(startDeliberation).not.toHaveBeenCalled();
  });

  it("surfaces a clear 'live disabled' message when the POST returns 503", async () => {
    // The flag-gated route returns 503 { code: "deliberation_live_disabled" }.
    startDeliberation.mockRejectedValue(
      new ApiError("disabled", 503, { code: "deliberation_live_disabled" }),
    );

    mount();
    await flush();

    setInputValue(
      container.querySelector('[data-testid="deliberation-task-input"]') as HTMLTextAreaElement,
      "anything",
    );
    click(container.querySelector('[data-testid="deliberation-submit"]'));
    await flush();

    expect(startDeliberation).toHaveBeenCalledTimes(1);
    // The live-disabled notice is shown; no generic error path.
    const notice = container.querySelector('[data-testid="deliberation-live-disabled"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain("WORKCELL_PAIR_LIVE_LLM");
    // It must NOT render the active-run timeline (no run was started).
    expect(container.querySelector('[data-testid="deliberation-run-timeline"]')).toBeNull();
    expect(container.querySelector('[data-testid="deliberation-start-error"]')).toBeNull();
  });
});
