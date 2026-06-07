// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeGraphPanel } from "./KnowledgeGraphPanel";

const neighborhoodMock = vi.hoisted(() => vi.fn());
vi.mock("../api/knowledge-graph", () => ({
  knowledgeGraphApi: {
    issueNeighborhood: (companyId: string, issueId: string) => neighborhoodMock(companyId, issueId),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("WC-123 KnowledgeGraphPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    neighborhoodMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <KnowledgeGraphPanel companyId="co-1" issueId="iss-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    // Let the query settle (resolve the mocked promise + commit the re-render).
    // react-query needs a macrotask boundary between resolving the queryFn and
    // committing the state update, so flush a few setTimeout(0) ticks.
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("queries the issue neighborhood with the company + issue ids", async () => {
    neighborhoodMock.mockResolvedValue({ node: null, connections: [] });
    await mount();
    expect(neighborhoodMock).toHaveBeenCalledWith("co-1", "iss-1");
  });

  it("renders nothing when the issue is not yet in the graph (node null)", async () => {
    neighborhoodMock.mockResolvedValue({ node: null, connections: [] });
    await mount();
    expect(container.querySelector('[data-testid="knowledge-graph-panel"]')).toBeNull();
  });

  it("renders nothing when there are no connections", async () => {
    neighborhoodMock.mockResolvedValue({
      node: { id: "n1", kind: "issue", label: "This" },
      connections: [],
    });
    await mount();
    expect(container.querySelector('[data-testid="knowledge-graph-panel"]')).toBeNull();
  });

  it("renders connections — issue neighbors link out, code neighbors are plain text", async () => {
    neighborhoodMock.mockResolvedValue({
      node: { id: "n1", kind: "issue", label: "This issue" },
      connections: [
        {
          id: "n2",
          kind: "issue",
          label: "Parent issue",
          entityRef: "PAP-2",
          edgeKind: "depends_on",
          direction: "out",
        },
        {
          id: "n3",
          kind: "code",
          label: "greet()",
          entityRef: "a_greet",
          edgeKind: "references",
          direction: "in",
        },
      ],
    });
    await mount();

    const panel = container.querySelector('[data-testid="knowledge-graph-panel"]');
    expect(panel).toBeTruthy();

    // Issue neighbor → navigable link to the issue route.
    const link = container.querySelector('a[href="/issues/PAP-2"]');
    expect(link?.textContent).toContain("Parent issue");

    // Code neighbor → plain text, NOT a link (no page to navigate to).
    expect(container.querySelector('a[href="/issues/a_greet"]')).toBeNull();
    expect(panel?.textContent).toContain("greet()");

    // Edge kinds surfaced (humanized English fallback).
    expect(panel?.textContent).toContain("depends on");
    expect(panel?.textContent).toContain("references");
  });
});
