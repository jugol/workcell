// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AGENT_ADAPTER_TYPES, getEnvironmentCapabilities } from "@workcell/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyEnvironments } from "./CompanyEnvironments";
import { CompanySettings } from "./CompanySettings";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockCompanyState = vi.hoisted(() => ({
  companies: [{ id: "company-1", name: "Workcell", issuePrefix: "PAP", status: "active" }],
  selectedCompany: {
    id: "company-1",
    name: "Workcell",
    description: null,
    brandColor: null,
    logoUrl: null,
    issuePrefix: "PAP",
    status: "active",
  } as Record<string, unknown>,
}));

const mockAccessApi = vi.hoisted(() => ({
  createOpenClawInvitePrompt: vi.fn(),
  getInviteOnboarding: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  probe: vi.fn(),
  probeConfig: vi.fn(),
  archive: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: mockCompanyState.companies,
    selectedCompany: mockCompanyState.selectedCompany,
    selectedCompanyId: "company-1",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyEnvironments", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableEnvironments: true,
    });
    mockEnvironmentsApi.list.mockResolvedValue([]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(
      getEnvironmentCapabilities(AGENT_ADAPTER_TYPES),
    );
    mockSecretsApi.list.mockResolvedValue([]);
    mockCompaniesApi.update.mockResolvedValue({
      id: "company-1",
      name: "Workcell",
      description: null,
      brandColor: null,
      logoUrl: null,
      issuePrefix: "PAP",
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("hides sandbox creation when no run-capable sandbox provider plugins are installed", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const optionLabels = Array.from(container.querySelectorAll("option")).map((option) => option.textContent?.trim());

    expect(optionLabels).not.toContain("Sandbox");
    expect(container.textContent).not.toContain("Fake sandbox");
    expect(container.textContent).not.toContain("Fake is the deterministic test provider");

    await act(async () => {
      root.unmount();
    });
  });

  it("preserves sandbox config when re-selecting the same provider while editing", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockEnvironmentsApi.list.mockResolvedValue([
      {
        id: "env-1",
        companyId: "company-1",
        name: "Secure Sandbox",
        description: null,
        driver: "sandbox",
        status: "active",
        config: {
          provider: "secure-plugin",
          template: "saved-template",
        },
        metadata: null,
        createdAt: new Date("2026-04-25T00:00:00.000Z"),
        updatedAt: new Date("2026-04-25T00:00:00.000Z"),
      },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(
      getEnvironmentCapabilities(AGENT_ADAPTER_TYPES, {
        sandboxProviders: {
          "secure-plugin": {
            status: "supported",
            supportsSavedProbe: true,
            supportsUnsavedProbe: true,
            supportsRunExecution: true,
            supportsReusableLeases: true,
            displayName: "Secure Sandbox",
            configSchema: {
              type: "object",
              properties: {
                template: { type: "string", title: "Template" },
              },
            },
          },
        },
      }),
    );

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyEnvironments />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Installed sandbox providers:");
    expect(container.textContent).toContain("Secure Sandbox");
    expect(container.textContent).toContain("These are not adapter types.");

    const editButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Edit");
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const providerSelect = Array.from(container.querySelectorAll("select"))
      .find((select) => Array.from(select.options).some((option) => option.value === "secure-plugin")) as HTMLSelectElement | undefined;
    expect(providerSelect).toBeTruthy();

    await act(async () => {
      providerSelect!.value = "secure-plugin";
      providerSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    const templateInput = Array.from(container.querySelectorAll("input"))
      .find((input) => (input as HTMLInputElement).value === "saved-template") as HTMLInputElement | undefined;
    expect(templateInput?.value).toBe("saved-template");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("CompanySettings autonomy section", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    mockCompaniesApi.update.mockResolvedValue({ id: "company-1", name: "Workcell", status: "active" });
    mockCompanyState.companies = [{ id: "company-1", name: "Workcell", issuePrefix: "PAP", status: "active" }];
    mockCompanyState.selectedCompany = {
      id: "company-1",
      name: "Workcell",
      description: null,
      brandColor: null,
      logoUrl: null,
      issuePrefix: "PAP",
      status: "active",
    };
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanySettings />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("renders the autonomy toggles with server defaults and patches on toggle", async () => {
    const root = await renderPage();

    expect(container.querySelector("[data-testid='company-settings-autonomy-section']")).toBeTruthy();
    expect(container.textContent).toContain("Autonomy");
    // Intervention-point copy for the default (recommended) state.
    expect(container.textContent).toContain("Your approval required");

    const approveToggle = container.querySelector(
      "[data-testid='company-settings-autonomy-approve-toggle']",
    ) as HTMLButtonElement;
    const routeToggle = container.querySelector(
      "[data-testid='company-settings-autonomy-route-toggle']",
    ) as HTMLButtonElement;
    const pairToggle = container.querySelector(
      "[data-testid='company-settings-autonomy-pair-toggle']",
    ) as HTMLButtonElement;
    expect(approveToggle).toBeTruthy();
    expect(routeToggle).toBeTruthy();
    expect(pairToggle).toBeTruthy();

    // Defaults: approvals wait for the user, routing/pair auto-run are on.
    expect(approveToggle.getAttribute("aria-checked")).toBe("false");
    expect(routeToggle.getAttribute("aria-checked")).toBe("true");
    expect(pairToggle.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      approveToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", {
      autoApproveConfirmations: true,
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("hosts the moved governance toggles (board approval, design-first)", async () => {
    const root = await renderPage();

    expect(container.querySelector("[data-testid='company-settings-team-approval-toggle']")).toBeTruthy();
    expect(container.querySelector("[data-testid='company-settings-design-first-toggle']")).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });
});

describe("CompanySettings danger zone", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    mockCompaniesApi.update.mockResolvedValue({ id: "company-1", name: "Workcell", status: "active" });
    mockCompaniesApi.archive.mockResolvedValue({ id: "company-1", status: "archived" });
    mockCompaniesApi.remove.mockResolvedValue({ ok: true });
    mockCompanyState.companies = [{ id: "company-1", name: "Workcell", issuePrefix: "PAP", status: "active" }];
    mockCompanyState.selectedCompany = {
      id: "company-1",
      name: "Workcell",
      description: null,
      brandColor: null,
      logoUrl: null,
      issuePrefix: "PAP",
      status: "active",
    };
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanySettings />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  function findButton(text: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === text,
    ) as HTMLButtonElement | undefined;
  }

  it("requires typing the company name before permanently deleting", async () => {
    const root = await renderPage();

    const deleteButton = findButton("Delete team");
    expect(deleteButton).toBeTruthy();

    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const confirmButton = findButton("Permanently delete");
    expect(confirmButton).toBeTruthy();
    // Disabled until the typed name matches exactly.
    expect(confirmButton!.disabled).toBe(true);

    const nameInput = container.querySelector(
      "input[aria-label='Type the team name to confirm:']",
    ) as HTMLInputElement;
    expect(nameInput).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(nameInput, "Workcell");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    expect(findButton("Permanently delete")!.disabled).toBe(false);

    await act(async () => {
      findButton("Permanently delete")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockCompaniesApi.remove).toHaveBeenCalledWith("company-1");

    await act(async () => {
      root.unmount();
    });
  });

  it("offers Unarchive on an archived company and calls update({ status: active })", async () => {
    mockCompanyState.companies = [{ id: "company-1", name: "Workcell", issuePrefix: "PAP", status: "archived" }];
    mockCompanyState.selectedCompany = {
      ...mockCompanyState.selectedCompany,
      status: "archived",
    };
    const root = await renderPage();

    expect(findButton("Delete team")).toBeTruthy();
    const unarchiveButton = findButton("Unarchive team");
    expect(unarchiveButton).toBeTruthy();
    // The plain "Archive company" action is not shown for an archived company.
    expect(findButton("Archive team")).toBeFalsy();

    await act(async () => {
      unarchiveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { status: "active" });

    await act(async () => {
      root.unmount();
    });
  });
});
