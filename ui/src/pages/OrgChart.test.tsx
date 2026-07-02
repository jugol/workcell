// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgChart } from "./OrgChart";

const navigateMock = vi.fn();
const orgMock = vi.fn();
const listMock = vi.fn();
const pairListMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => navigateMock,
}));

vi.mock("../api/pair-groups", () => ({
  pairGroupsApi: {
    listForCompany: () => pairListMock(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    org: () => orgMock(),
    list: () => listMock(),
  },
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const orgTree = [
  {
    id: "agent-1",
    name: "CEO",
    role: "ceo",
    status: "active",
    reports: [
      {
        id: "agent-2",
        name: "Engineer",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ],
  },
];

const agents = [
  {
    id: "agent-1",
    companyId: "company-1",
    name: "CEO",
    role: "ceo",
    title: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "briefcase",
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "ceo",
    pauseReason: null,
    pausedAt: null,
    permissions: null,
  },
  {
    id: "agent-2",
    companyId: "company-1",
    name: "Engineer",
    role: "engineer",
    title: null,
    status: "active",
    reportsTo: "agent-1",
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "code",
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "engineer",
    pauseReason: null,
    pausedAt: null,
    permissions: null,
  },
];

function createTouchEvent(type: string, touches: Array<{ clientX: number; clientY: number }>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: touches,
  });
  Object.defineProperty(event, "changedTouches", {
    value: touches,
  });
  return event;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("OrgChart mobile gestures", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    orgMock.mockResolvedValue(orgTree);
    listMock.mockResolvedValue(agents);
    pairListMock.mockResolvedValue({ bindings: [] });

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? 360 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? 520 : 0;
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getRect(this: HTMLElement) {
      if (this.getAttribute("data-testid") === "org-chart-viewport") {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 360,
          bottom: 520,
          width: 360,
          height: 520,
          toJSON: () => ({}),
        };
      }
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      };
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function renderOrgChart() {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OrgChart />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return {
      viewport: container.querySelector('[data-testid="org-chart-viewport"]') as HTMLDivElement,
      layer: container.querySelector('[data-testid="org-chart-card-layer"]') as HTMLDivElement,
    };
  }

  it("pans the chart with one-finger touch drag", async () => {
    const { viewport, layer } = await renderOrgChart();

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
    });

    expect(layer.style.transform).toBe("translate(50px, 105px) scale(1)");
  });

  it("suppresses card navigation after a touch pan", async () => {
    const { viewport } = await renderOrgChart();
    const card = container.querySelector("[data-org-card]") as HTMLDivElement;

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
      card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("allows card navigation after a touch tap without movement", async () => {
    const { viewport } = await renderOrgChart();
    const card = container.querySelector("[data-org-card]") as HTMLDivElement;

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
      card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(navigateMock).toHaveBeenCalledWith("/agents/ceo");
  });
  it("pinch-zooms toward the touch center", async () => {
    const { viewport, layer } = await renderOrgChart();

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [
        { clientX: 100, clientY: 100 },
        { clientX: 200, clientY: 100 },
      ]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [
        { clientX: 75, clientY: 100 },
        { clientX: 225, clientY: 100 },
      ]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
    });

    expect(layer.style.transform).toBe("translate(-45px, 40px) scale(1.5)");
  });
});

describe("OrgChart pair visibility (WC-189)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    orgMock.mockResolvedValue(orgTree);
    listMock.mockResolvedValue(agents);
    pairListMock.mockResolvedValue({ bindings: [] });

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? 800 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? 600 : 0;
      },
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OrgChart />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("marks paired nodes and draws a connector when two agents are paired", async () => {
    pairListMock.mockResolvedValue({
      bindings: [
        {
          pairGroupId: "pg-1",
          companyId: "company-1",
          issueId: "issue-1",
          issueIdentifier: "WC-12",
          issueTitle: "Pair candidate",
          status: "active",
          ownerAgentId: "agent-1",
          ownerAgentName: "CEO",
          counterpartAgentId: "agent-2",
          counterpartAgentName: "Engineer",
        },
      ],
    });

    await render();

    // Both paired nodes show a "⇄ 페어" marker.
    const badges = container.querySelectorAll('[data-testid="pair-badge"]');
    expect(badges).toHaveLength(2);
    expect(badges[0].textContent).toContain("Pair");
    // The marker names the counterpart + issue via its title.
    const titles = Array.from(badges).map((b) => b.getAttribute("title"));
    expect(titles).toContain("Paired with Engineer on WC-12");
    expect(titles).toContain("Paired with CEO on WC-12");

    // A connector links the two paired nodes, tagged with the group id.
    const connector = container.querySelector('[data-testid="org-pair-connector"]');
    expect(connector).not.toBeNull();
    expect(connector!.getAttribute("data-pair-group-id")).toBe("pg-1");
    expect(connector!.textContent).toContain("⇄ WC-12");
  });

  it("renders no pair marker or connector when there are no active pairs", async () => {
    pairListMock.mockResolvedValue({ bindings: [] });

    await render();

    expect(container.querySelectorAll('[data-testid="pair-badge"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="org-pair-connector"]')).toBeNull();
  });

  it("renders a merged pair as ONE node with both names, two status dots and no connector", async () => {
    // Server-side merge output: the counterpart is gone from the tree and
    // rides along on the primary node as `pair`; both sides' reports are
    // already merged under the primary.
    orgMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "CEO",
        role: "ceo",
        status: "active",
        pair: { id: "agent-2", name: "Engineer", role: "engineer", status: "error" },
        reports: [
          { id: "agent-3", name: "Worker", role: "worker", status: "active", reports: [] },
        ],
      },
    ]);
    pairListMock.mockResolvedValue({
      bindings: [
        {
          pairGroupId: "pg-1",
          companyId: "company-1",
          issueId: "issue-1",
          issueIdentifier: "WC-12",
          issueTitle: "Pair candidate",
          status: "active",
          ownerAgentId: "agent-1",
          ownerAgentName: "CEO",
          counterpartAgentId: "agent-2",
          counterpartAgentName: "Engineer",
        },
      ],
    });

    await render();

    const cards = container.querySelectorAll("[data-org-card]");
    expect(cards).toHaveLength(2); // merged pair + the single worker

    // One card carries both names joined by ⇄.
    const mergedCard = Array.from(cards).find((c) => c.textContent?.includes("⇄"))!;
    expect(mergedCard.textContent).toContain("CEO ⇄ Engineer");

    // Second status dot for the counterpart brain, colored by ITS status.
    const pairDot = mergedCard.querySelector('[data-testid="org-pair-status-dot"]') as HTMLElement;
    expect(pairDot).not.toBeNull();
    expect(pairDot.style.backgroundColor).toBe("rgb(248, 113, 113)"); // error → #f87171

    // The merged node shows the issue ref instead of the PairBadge…
    expect(mergedCard.querySelector('[data-testid="org-pair-issue-ref"]')!.textContent).toBe("⇄ WC-12");
    expect(container.querySelectorAll('[data-testid="pair-badge"]')).toHaveLength(0);

    // …and no dashed connector (the counterpart node no longer exists).
    expect(container.querySelector('[data-testid="org-pair-connector"]')).toBeNull();
  });
});
