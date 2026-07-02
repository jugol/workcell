// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMemoryTab } from "./AgentMemoryTab";
import type { AgentMemoryGraph } from "../api/agent-memory";

// Mock the agent-memory api so the tab renders from fixtures and we can assert
// the forget call. Mirrors PairSetupPanel.test's api-mock approach.
const getMemoryGraphMock = vi.hoisted(() => vi.fn());
const deleteMemoryNodeMock = vi.hoisted(() => vi.fn());
const upsertMemoryNodeMock = vi.hoisted(() => vi.fn());

vi.mock("../api/agent-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/agent-memory")>();
  return {
    ...actual,
    agentMemoryApi: {
      getMemoryGraph: (agentId: string) => getMemoryGraphMock(agentId),
      deleteMemoryNode: (agentId: string, nodeId: string) =>
        deleteMemoryNodeMock(agentId, nodeId),
      upsertMemoryNode: (agentId: string, body: unknown) =>
        upsertMemoryNodeMock(agentId, body),
    },
  };
});

// Link from @/lib/router needs the company-prefix context; stub to a plain <a>.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={typeof to === "string" ? to : "#"}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeNode(over: Partial<AgentMemoryGraph["nodes"][number]> = {}) {
  return {
    id: "node-1",
    companyId: "company-1",
    agentId: "agent-1",
    kind: "fact",
    label: "Prefers TypeScript",
    content: "The team standardized on TypeScript for all services.",
    metadata: { confidence: "high" },
    sourceRunId: "11111111-2222-3333-4444-555555555555",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
    ...over,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function click(el: Element | null | undefined) {
  act(() => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
}

describe("AgentMemoryTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    getMemoryGraphMock.mockReset();
    deleteMemoryNodeMock.mockReset();
    upsertMemoryNodeMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function mount() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <AgentMemoryTab agentId="agent-1" companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders nodes from the mocked graph", async () => {
    getMemoryGraphMock.mockResolvedValue({ nodes: [makeNode()], edges: [] });
    await mount();

    expect(getMemoryGraphMock).toHaveBeenCalledWith("agent-1");
    // The node label is drawn on the graph canvas card.
    expect(container.textContent).toContain("Prefers TypeScript");
    // Node count badge.
    const tab = container.querySelector('[data-testid="agent-memory-tab"]');
    expect(tab).not.toBeNull();
  });

  it("shows the node content + provenance when its node is clicked", async () => {
    getMemoryGraphMock.mockResolvedValue({ nodes: [makeNode()], edges: [] });
    await mount();

    // Detail panel is not shown until a node is selected.
    expect(container.querySelector('[data-testid="agent-memory-detail"]')).toBeNull();

    const nodeButton = container.querySelector<HTMLButtonElement>("[data-graph-node]");
    expect(nodeButton).not.toBeNull();
    click(nodeButton);
    await flushReact();

    const detail = container.querySelector('[data-testid="agent-memory-detail"]');
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain(
      "The team standardized on TypeScript for all services.",
    );
    // Provenance run id (truncated) + metadata key rendered.
    expect(detail!.textContent).toContain("11111111");
    expect(detail!.textContent).toContain("confidence");
  });

  it("calls deleteMemoryNode when Forget is confirmed", async () => {
    getMemoryGraphMock.mockResolvedValue({ nodes: [makeNode()], edges: [] });
    deleteMemoryNodeMock.mockResolvedValue(makeNode());
    await mount();

    click(container.querySelector<HTMLButtonElement>("[data-graph-node]"));
    await flushReact();

    // First click reveals the confirm step; the api is not called yet.
    click(findButton(container, "Forget"));
    await flushReact();
    expect(deleteMemoryNodeMock).not.toHaveBeenCalled();

    // Confirm actually forgets.
    click(findButton(container, "Confirm forget"));
    await flushReact();
    expect(deleteMemoryNodeMock).toHaveBeenCalledWith("agent-1", "node-1");
  });

  it("renders the empty state when the graph has no nodes", async () => {
    getMemoryGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    await mount();

    expect(container.querySelector('[data-testid="agent-memory-empty"]')).not.toBeNull();
    expect(container.textContent).toContain("This agent has no memories yet");
    // No graph canvas when empty.
    expect(container.querySelector('[data-testid="graph-canvas"]')).toBeNull();
  });
});
