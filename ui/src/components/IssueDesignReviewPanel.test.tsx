// @vitest-environment jsdom

import { act } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
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
const getIssueMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("../api/issues", () => ({
  issuesApi: {
    listWorkProducts: (id: string) => listWorkProductsMock(id),
    submitDesignReview: (id: string) => submitMock(id),
    approveDesignReview: (id: string) => approveMock(id),
    requestDesignChanges: (id: string, reason?: string) => requestChangesMock(id, reason),
    createDesignArtifact: (id: string, data: unknown) => createDesignArtifactMock(id, data),
    get: (id: string) => getIssueMock(id),
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

const listForProjectMock = vi.hoisted(() => vi.fn());

vi.mock("../api/design-artifacts", () => ({
  designArtifactsApi: {
    listForProject: (projectId: string) => listForProjectMock(projectId),
  },
}));

// WC-200: the panel links to the project design system via the company-aware
// Link — stub it as a plain anchor so no Router/CompanyContext is required.
vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: { children?: ReactNode; to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
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
    // WC-200: the design-requirement query reuses issuesApi.get — the panel only
    // reads designRequirement and projectId from it.
    getIssueMock
      .mockReset()
      .mockResolvedValue({ id: "issue-1", projectId: "project-1", designRequirement: null });
    pushToastMock.mockReset();
    listForProjectMock.mockReset().mockResolvedValue({ items: [] });
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

  it("Q2: a design_request child holding a needs_board_review 시안 shows the board approve control", async () => {
    // The inbox surfaces a child's own pending 시안 as a board 할 일. This child
    // used to render only "attach to parent" guidance with NO approve control,
    // stranding the board on a page with nothing to click. It must now let the
    // board decide on the pending 시안 right here.
    getIssueMock.mockReset().mockResolvedValue({
      id: "issue-1",
      projectId: "project-1",
      designRequirement: null,
      originKind: "design_request",
      originId: "parent-1",
    });
    listWorkProductsMock.mockResolvedValue([
      design({
        id: "wp-child",
        isPrimary: true,
        reviewState: "needs_board_review",
        screenKey: "home",
        title: "Home 시안",
        url: "https://designs.test/home",
      }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-request-pending-review"]')).toBeTruthy();
    const approveBtn = container.querySelector('[data-testid="design-review-approve"]');
    expect(approveBtn).toBeTruthy();
    click(approveBtn);
    await flush();
    expect(approveMock).toHaveBeenCalledWith("wp-child");
  });

  it("Q2: a multi-screen design_request child keeps offering the approve control for the NEXT pending screen after the first is approved", async () => {
    getIssueMock.mockReset().mockResolvedValue({
      id: "issue-1",
      projectId: "project-1",
      designRequirement: null,
      originKind: "design_request",
      originId: "parent-1",
    });
    // Screen "home" already approved; screen "settings" still pending. The panel
    // must surface the approve control for the PENDING screen — not fall back to
    // guidance-only because the first/primary screen happens to be approved
    // (which would re-create the To-do-with-no-button strand, one screen deep).
    listWorkProductsMock.mockResolvedValue([
      design({
        id: "wp-home",
        isPrimary: true,
        reviewState: "approved",
        screenKey: "home",
        title: "Home 시안",
      }),
      design({
        id: "wp-settings",
        isPrimary: true,
        reviewState: "needs_board_review",
        screenKey: "settings",
        title: "Settings 시안",
      }),
    ]);
    await mount();
    const approveBtn = container.querySelector('[data-testid="design-review-approve"]');
    expect(approveBtn).toBeTruthy();
    click(approveBtn);
    await flush();
    expect(approveMock).toHaveBeenCalledWith("wp-settings");
  });

  it("Q2: a design_request child with no 시안 of its own keeps the attach-to-parent guidance and shows no approve control", async () => {
    getIssueMock.mockReset().mockResolvedValue({
      id: "issue-1",
      projectId: "project-1",
      designRequirement: null,
      originKind: "design_request",
      originId: "parent-1",
    });
    listWorkProductsMock.mockResolvedValue([]);
    await mount();
    expect(container.querySelector('[data-testid="design-request-guidance"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-review-approve"]')).toBeNull();
  });

  it("attaches a screen design picked from the project design system with provenance", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    listForProjectMock.mockResolvedValue({
      items: [
        // Own-issue artifacts must be filtered out of the picker.
        {
          id: "wp-own",
          issueId: "issue-1",
          type: "design",
          title: "Already here",
          reviewState: "none",
          previewUrl: null,
          body: null,
        },
        {
          id: "wp-screen",
          issueId: "issue-2",
          type: "design",
          title: "Onboarding screen v2",
          reviewState: "approved",
          previewUrl: "https://designs.test/onboarding-v2",
          body: "Final onboarding 시안",
        },
      ],
    });
    await mount();

    click(container.querySelector('[data-testid="design-review-pick-toggle"]'));
    await flush();

    expect(listForProjectMock).toHaveBeenCalledWith("project-1");
    expect(container.querySelector('[data-testid="design-review-pick-wp-own"]')).toBeNull();
    const useButton = container.querySelector('[data-testid="design-review-pick-wp-screen"]');
    expect(useButton).toBeTruthy();

    click(useButton);
    await flush();

    expect(createDesignArtifactMock).toHaveBeenCalledTimes(1);
    expect(createDesignArtifactMock).toHaveBeenCalledWith("issue-1", {
      title: "Onboarding screen v2",
      url: "https://designs.test/onboarding-v2",
      type: "design",
      summary: "Final onboarding 시안",
      isPrimary: true,
      metadata: { sourceWorkProductId: "wp-screen" },
    });
  });

  it("drops a non-absolute catalog previewUrl so the attach does not fail server URL validation", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    listForProjectMock.mockResolvedValue({
      items: [
        {
          id: "wp-rel",
          issueId: "issue-2",
          type: "design",
          title: "Externally ingested mock",
          reviewState: "none",
          // A relative path / bare slug — fails server zod .url(); must be dropped.
          previewUrl: "/designs/ingested-mock",
          body: null,
        },
      ],
    });
    await mount();
    click(container.querySelector('[data-testid="design-review-pick-toggle"]'));
    await flush();
    click(container.querySelector('[data-testid="design-review-pick-wp-rel"]'));
    await flush();

    expect(createDesignArtifactMock).toHaveBeenCalledTimes(1);
    expect(createDesignArtifactMock).toHaveBeenCalledWith("issue-1", {
      title: "Externally ingested mock",
      url: undefined,
      type: "design",
      summary: undefined,
      isPrimary: true,
      metadata: { sourceWorkProductId: "wp-rel" },
    });
  });

  it("hides the design-system picker when the issue has no project", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    getIssueMock.mockResolvedValue({ id: "issue-1", projectId: null, designRequirement: null });
    await mount();
    expect(container.querySelector('[data-testid="design-review-attach-toggle"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-review-pick-toggle"]')).toBeNull();
  });

  it("shows 시안-creation guidance (not the exempt toggle) for a design_request child", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    getIssueMock.mockImplementation((id: string) =>
      id === "parent-1"
        ? Promise.resolve({ id: "parent-1", identifier: "LOR-86", title: "Screen work", projectId: "project-1" })
        : Promise.resolve({
            id: "issue-1",
            projectId: "project-1",
            originKind: "design_request",
            originId: "parent-1",
            designRequirement: { required: false, setByKind: "auto" },
          }),
    );
    await mount();

    // The 시안-creation guidance shows, and the confusing "design not required"
    // toggle / attach UI does NOT.
    expect(container.querySelector('[data-testid="design-request-guidance"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-requirement-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="design-review-attach-toggle"]')).toBeNull();
    // It points the designer at the PARENT, where the 시안 must land.
    const link = container.querySelector('[data-testid="design-request-parent-link"]');
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/issues/LOR-86");
    expect(container.textContent).toContain("LOR-86");
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

  it("WC-203: offers expand + open-in-new-tab on the 시안 preview, and the modal stays sandboxed", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ isPrimary: true, reviewState: "needs_board_review", url: "/api/assets/abc/content" }),
    ]);
    await mount();

    // The inline preview renders, plus an open-in-new-tab anchor to the 시안.
    expect(container.querySelector('[data-testid="design-review-preview"]')).toBeTruthy();
    const newtab = container.querySelector('[data-testid="design-review-preview-newtab"]') as HTMLAnchorElement;
    expect(newtab).toBeTruthy();
    expect(newtab.getAttribute("href")).toBe("/api/assets/abc/content");
    expect(newtab.getAttribute("target")).toBe("_blank");
    expect(newtab.getAttribute("rel")).toBe("noreferrer");

    // Expand opens a LARGE modal iframe (portaled to document) — still sandboxed.
    expect(document.querySelector('[data-testid="design-review-preview-modal"]')).toBeNull();
    click(container.querySelector('[data-testid="design-review-preview-expand"]'));
    await flush();
    const modal = document.querySelector('[data-testid="design-review-preview-modal"]') as HTMLIFrameElement;
    expect(modal).toBeTruthy();
    expect(modal.getAttribute("sandbox")).toBe("");
    expect(modal.getAttribute("src")).toBe("/api/assets/abc/content");
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
    // Also invalidates the company/project design-artifact lists so the 시안
    // clears from the board's inbox (할 일 tab) + badge immediately.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["design-artifacts"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["project-design-artifacts"] });
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

  it("multiple screens on one issue → a screen selector lets the board review each (R5)", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ id: "d1", isPrimary: true, reviewState: "approved", title: "Login", screenKey: "login", screenName: "Login" }),
      design({ id: "d2", isPrimary: true, reviewState: "needs_board_review", title: "Home", screenKey: "home", screenName: "Home" }),
    ]);
    await mount();
    // Two screens → selector appears with a chip per screen + approval progress.
    expect(container.querySelector('[data-testid="design-review-screen-selector"]')).toBeTruthy();
    const chips = container.querySelectorAll('[data-testid="design-review-screen-chip"]');
    expect(chips.length).toBe(2);
    // Default active screen is the first (sorted by name → "Home"); switching to
    // a different chip changes which screen the gate below reviews.
    click(chips[1]); // "Login"
    await flush();
    expect(
      container.querySelector('[data-testid="design-review-authoritative"] span[title="Login"]'),
    ).toBeTruthy();
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

  // WC-200: the approved design is framed as the implementation target — the
  // emphasis card carries the title plus a view link when the design has a URL.
  it("renders the implementation-target view link when the approved design has a url", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ isPrimary: true, reviewState: "approved", url: "https://figma.com/file/abc" }),
    ]);
    await mount();
    const link = container.querySelector(
      '[data-testid="design-review-target-link"]',
    ) as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("https://figma.com/file/abc");
  });

  it("omits the implementation-target view link when the approved design has no url", async () => {
    listWorkProductsMock.mockResolvedValue([
      design({ isPrimary: true, reviewState: "approved", url: null }),
    ]);
    await mount();
    expect(container.querySelector('[data-testid="design-review-approved"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-review-target-link"]')).toBeNull();
  });

  // WC-200: the project design system is the source of truth for the project's
  // design planning — the panel links to it whenever the issue has a project.
  it("links to the project design system when the issue belongs to a project", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    await mount();
    const link = container.querySelector(
      '[data-testid="design-review-project-design-link"]',
    ) as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/projects/project-1/design");
  });

  it("hides the project design system link when the issue has no project", async () => {
    getIssueMock.mockResolvedValue({ id: "issue-1", projectId: null, designRequirement: null });
    listWorkProductsMock.mockResolvedValue([]);
    await mount();
    expect(
      container.querySelector('[data-testid="design-review-project-design-link"]'),
    ).toBeNull();
  });

  it("shows the design-system note in the empty state unless the issue is design-exempt", async () => {
    listWorkProductsMock.mockResolvedValue([]);
    await mount();
    expect(
      container.querySelector('[data-testid="design-review-design-system-note"]'),
    ).toBeTruthy();
  });

  it("hides the design-system note when the issue is design-exempt", async () => {
    getIssueMock.mockResolvedValue({
      id: "issue-1",
      projectId: "project-1",
      designRequirement: { required: false, reason: null, setByKind: "user" },
    });
    listWorkProductsMock.mockResolvedValue([]);
    await mount();
    expect(
      container.querySelector('[data-testid="design-review-design-system-note"]'),
    ).toBeNull();
  });
});
