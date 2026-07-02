// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@workcell/shared";
import { queryKeys } from "../lib/queryKeys";
import {
  CompanyProvider,
  resolveBootstrapCompanySelection,
  shouldClearStoredCompanySelection,
  useCompany,
} from "./CompanyContext";

const mockCompaniesApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

const activeCompany = { id: "company-1" };
const secondActiveCompany = { id: "company-2" };
const archivedCompany = { id: "archived-company" };

function makeCompany(id: string): Company {
  return {
    id,
    name: "Workcell",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "PAP",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 10 * 1024 * 1024,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    planReportLanguage: "en",
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function Probe({ onSelectedCompanyId }: { onSelectedCompanyId: (companyId: string | null) => void }) {
  const { selectedCompanyId } = useCompany();
  useEffect(() => {
    onSelectedCompanyId(selectedCompanyId);
  }, [onSelectedCompanyId, selectedCompanyId]);
  return <div data-selected-company-id={selectedCompanyId ?? ""} />;
}

describe("resolveBootstrapCompanySelection", () => {
  it("does not expose a stale stored company id before companies load", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [],
      sidebarCompanies: [],
      selectedCompanyId: null,
      storedCompanyId: "stale-company",
    })).toBeNull();
  });

  it("replaces a stale stored company id with the first loaded company", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: null,
      storedCompanyId: "stale-company",
    })).toBe("company-1");
  });

  it("keeps a valid selected company ahead of stored bootstrap state", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: "company-1",
      storedCompanyId: "stale-company",
    })).toBe("company-1");
  });

  it("keeps a valid stored company id instead of falling back to the first company", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany, secondActiveCompany],
      sidebarCompanies: [activeCompany, secondActiveCompany],
      selectedCompanyId: null,
      storedCompanyId: "company-2",
    })).toBe("company-2");
  });

  it("uses selectable sidebar companies before archived companies", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [archivedCompany, activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: null,
      storedCompanyId: "archived-company",
    })).toBe("company-1");
  });
});

describe("shouldClearStoredCompanySelection", () => {
  it("does not clear the stored company selection during an unauthorized company list response", () => {
    expect(shouldClearStoredCompanySelection({
      companies: [],
      isLoading: false,
      unauthorized: true,
    })).toBe(false);
  });

  it("clears the stored company selection when an authorized company list is empty", () => {
    expect(shouldClearStoredCompanySelection({
      companies: [],
      isLoading: false,
      unauthorized: false,
    })).toBe(true);
  });
});

describe("CompanyProvider", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it("does not expose a stale stored company id before companies load", async () => {
    localStorage.setItem("workcell.selectedCompanyId", "stale-company");
    mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));
    const seen: Array<string | null> = [];

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <Probe onSelectedCompanyId={(companyId) => seen.push(companyId)} />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });

    expect(seen).toEqual([null]);
  });

  it("replaces a stale stored company id with the first loaded company", async () => {
    localStorage.setItem("workcell.selectedCompanyId", "stale-company");
    queryClient.setQueryData(queryKeys.companies.all, {
      companies: [makeCompany("company-1")],
      unauthorized: false,
    });
    mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));
    const seen: Array<string | null> = [];

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <Probe onSelectedCompanyId={(companyId) => seen.push(companyId)} />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });

    expect(seen).toEqual([null, "company-1"]);
    expect(localStorage.getItem("workcell.selectedCompanyId")).toBe("company-1");
  });

  // Regression for the intermittent "Maximum update depth exceeded"
  // ErrorBoundary: the bootstrap effect used to OVERRIDE any selection missing
  // from the cached list, ping-ponging with route-level syncs (AgentDetail /
  // onboarding) whenever the list was stale. The three tests below pin the
  // loop guards.
  function ContextHandle({ onCtx }: { onCtx: (ctx: ReturnType<typeof useCompany>) => void }) {
    const ctx = useCompany();
    useEffect(() => {
      onCtx(ctx);
    }, [onCtx, ctx]);
    return null;
  }

  it("keeps an explicit selection missing from a still-refetching (stale) list", async () => {
    queryClient.setQueryData(queryKeys.companies.all, {
      companies: [makeCompany("company-1")],
      unauthorized: false,
    });
    // Never-resolving fetch => the list stays in isFetching with stale data.
    mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));
    let ctx: ReturnType<typeof useCompany> | null = null;

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <ContextHandle onCtx={(value) => { ctx = value; }} />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });
    expect(ctx!.selectedCompanyId).toBe("company-1");

    // Simulate AgentDetail / fresh-company route sync selecting an id the
    // stale cached list does not contain yet.
    await act(async () => {
      ctx!.setSelectedCompanyId("company-2", { source: "route_sync" });
    });
    expect(ctx!.selectedCompanyId).toBe("company-2");
  });

  it("keeps a selection that exists in the full list even when sidebar excludes it (archived)", async () => {
    const archived = { ...makeCompany("company-arch"), status: "archived" as const };
    mockCompaniesApi.list.mockResolvedValue([archived, makeCompany("company-1")]);
    let ctx: ReturnType<typeof useCompany> | null = null;

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <ContextHandle onCtx={(value) => { ctx = value; }} />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      ctx!.setSelectedCompanyId("company-arch");
    });
    expect(ctx!.selectedCompanyId).toBe("company-arch");
  });

  it("still falls back when the selected company is genuinely absent after the list settles", async () => {
    mockCompaniesApi.list.mockResolvedValue([makeCompany("company-1")]);
    let ctx: ReturnType<typeof useCompany> | null = null;

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <ContextHandle onCtx={(value) => { ctx = value; }} />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      ctx!.setSelectedCompanyId("ghost-company");
    });
    // List is settled (not fetching) and ghost-company is absent — the
    // bootstrap effect may legitimately reset to a real company.
    expect(ctx!.selectedCompanyId).toBe("company-1");
  });
});
