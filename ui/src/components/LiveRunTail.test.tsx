// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HeartbeatRunEvent } from "@workcell/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { LiveRunTail, linesFromLogContent, linesFromRunEvents } from "./LiveRunTail";

// Mock the heartbeats api the tail polls. Each test sets the behaviour.
const getRun = vi.hoisted(() => vi.fn());
const getEvents = vi.hoisted(() => vi.fn());
const getLog = vi.hoisted(() => vi.fn());
vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    get: (...args: unknown[]) => getRun(...args),
    events: (...args: unknown[]) => getEvents(...args),
    log: (...args: unknown[]) => getLog(...args),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  getRun.mockReset();
  getEvents.mockReset();
  getLog.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

async function renderTail(runId = "run-tail-1") {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <LiveRunTail runId={runId} />
      </QueryClientProvider>,
    );
  });
  // Drain microtasks + two macrotasks so the react-query fetch AND its
  // batched notification both settle inside act().
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-tail-1",
    status: "running",
    logBytes: 0,
    lastOutputBytes: 0,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<HeartbeatRunEvent> = {}): HeartbeatRunEvent {
  return {
    id: 1,
    companyId: "co-1",
    runId: "run-tail-1",
    agentId: "agent-1",
    seq: 1,
    eventType: "lifecycle",
    stream: "system",
    level: "info",
    color: null,
    message: "run started",
    payload: null,
    createdAt: new Date("2026-06-10T10:00:00.000Z"),
    ...overrides,
  };
}

function logRow(ts: string, stream: string, chunk: string) {
  return `${JSON.stringify({ ts, stream, chunk })}\n`;
}

describe("LiveRunTail", () => {
  it("shows the waiting placeholder when the run has produced no output yet", async () => {
    getRun.mockResolvedValue(makeRun());
    getEvents.mockResolvedValue([]);
    // Live runs may not have a log file yet — the tail must treat 404 as "no output".
    getLog.mockRejectedValue(new ApiError("run log not found", 404, null));

    await renderTail();

    expect(container.querySelector('[data-testid="live-run-tail"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="live-run-tail-empty"]')).not.toBeNull();
    expect(container.textContent).toContain("Waiting for output…");
  });

  it("renders log chunks and run events, with stderr toned as an error line", async () => {
    getRun.mockResolvedValue(makeRun());
    getEvents.mockResolvedValue([
      makeEvent({ seq: 1, message: "run started" }),
      makeEvent({
        seq: 2,
        eventType: "error",
        stream: "stderr",
        level: "error",
        message: "adapter exploded",
        createdAt: new Date("2026-06-10T10:00:02.000Z"),
      }),
    ]);
    getLog.mockResolvedValue({
      runId: "run-tail-1",
      store: "file",
      logRef: "run.log",
      content:
        logRow("2026-06-10T10:00:01.000Z", "stdout", "Thinking about the fix…\n") +
        logRow("2026-06-10T10:00:03.000Z", "stderr", "warning: lockfile drift\n"),
    });

    await renderTail();

    expect(container.querySelector('[data-testid="live-run-tail-empty"]')).toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("run started");
    expect(text).toContain("Thinking about the fix…");
    expect(text).toContain("adapter exploded");
    expect(text).toContain("warning: lockfile drift");

    const stderrLine = Array.from(container.querySelectorAll("div")).find((node) =>
      node.textContent === "warning: lockfile drift",
    );
    expect(stderrLine?.className).toContain("text-amber-700");

    const stdoutLine = Array.from(container.querySelectorAll("div")).find((node) =>
      node.textContent === "Thinking about the fix…",
    );
    expect(stdoutLine?.className).toContain("text-foreground");
  });
});

describe("linesFromLogContent", () => {
  it("parses NDJSON rows, splits multi-line chunks, and carries partial rows", () => {
    const state = { pendingLogRow: "", lineSeq: 0 };
    const lines = linesFromLogContent(
      logRow("2026-06-10T10:00:00.000Z", "stdout", "line one\nline two\n") +
        '{"ts":"2026-06-10T10:00:01.000Z","stream":"std', // partial row carried over
      state,
    );
    expect(lines.map((line) => line.text)).toEqual(["line one", "line two"]);
    expect(lines.every((line) => line.stream === "stdout")).toBe(true);
    expect(state.pendingLogRow).toContain('"2026-06-10T10:00:01.000Z"');

    // The carried partial row completes on the next poll.
    const next = linesFromLogContent('out","chunk":"tail done\\n"}\n', state);
    expect(next.map((line) => line.text)).toEqual(["tail done"]);
  });
});

describe("linesFromRunEvents", () => {
  it("keeps only events with messages and flags error streams", () => {
    const lines = linesFromRunEvents([
      makeEvent({ seq: 1, message: "run started" }),
      makeEvent({ seq: 2, message: null }),
      makeEvent({ seq: 3, eventType: "error", level: "error", message: "boom" }),
    ]);
    expect(lines.map((line) => line.text)).toEqual(["run started", "boom"]);
    expect(lines[0].stream).toBe("system");
    expect(lines[1].stream).toBe("stderr");
  });
});
