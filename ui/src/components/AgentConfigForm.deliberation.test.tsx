// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@workcell/shared";

// WC-205 (deliberation mode, slice 2): the per-agent dual-brain consensus
// config is settable in the edit form and flows into the update payload.
//
// The form fans out to many adapter/secret/environment queries; we mock the api
// modules so they resolve immediately, and pin the company context so the
// queries are enabled. We assert on stable test ids + the captured onSave
// payload (mirrors PairSetupPanel.test's api-mock + onSubmit-assertion style).

const adapterModelsMock = vi.hoisted(() => vi.fn(async () => []));
const detectModelMock = vi.hoisted(() => vi.fn(async () => null));
const adapterModelProfilesMock = vi.hoisted(() => vi.fn(async () => []));
const listAgentsMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../api/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/agents")>();
  return {
    ...actual,
    agentsApi: {
      ...actual.agentsApi,
      adapterModels: () => adapterModelsMock(),
      detectModel: () => detectModelMock(),
      adapterModelProfiles: () => adapterModelProfilesMock(),
      list: () => listAgentsMock(),
    },
  };
});

vi.mock("../api/secrets", () => ({
  secretsApi: { list: vi.fn(async () => []), create: vi.fn() },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: vi.fn(async () => ({ enableEnvironments: false })) },
}));

vi.mock("../api/environments", () => ({
  environmentsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

// Pin the selected company so the form's queries are enabled.
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

// MarkdownEditor pulls in sandpack, which crashes jsdom's CSS parser at import
// time — stub it (and the instructions editor that wraps it), mirroring the
// MarkdownEditor mock used across the other component tests.
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="markdown-editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock("./AgentInstructionsEditor", () => ({
  AgentInstructionsEditor: () => <div data-testid="agent-instructions-editor" />,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentConfigForm } from "./AgentConfigForm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Builder",
    urlKey: "builder",
    role: "general",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    deliberation: null,
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...over,
  } as Agent;
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

// React tracks the input's value internally; setting `.value` directly is not
// observed. Use the native value setter so React's onChange sees the new value.
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// Same trick for a native <select>: use the prototype value setter, then fire a
// change event so React's onChange picks up the new option (WC-208 adapter pick).
function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

async function renderForm(agent: Agent, onSave: (patch: Record<string, unknown>) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <AgentConfigForm mode="edit" agent={agent} onSave={onSave} hideInlineSave={false} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await flushReact();
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

beforeEach(() => {
  adapterModelsMock.mockResolvedValue([]);
  detectModelMock.mockResolvedValue(null);
  adapterModelProfilesMock.mockResolvedValue([]);
  listAgentsMock.mockResolvedValue([]);
});

describe("AgentConfigForm — deliberation section (WC-205)", () => {
  it("renders the deliberation section with the brain pickers hidden until enabled", async () => {
    await renderForm(makeAgent(), vi.fn());

    expect(container.querySelector('[data-testid="deliberation-section"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="deliberation-enabled-toggle"]')).not.toBeNull();
    // Hidden while disabled.
    expect(container.querySelector('[data-testid="deliberation-config"]')).toBeNull();
    expect(container.querySelector('[data-testid="deliberation-brain-a"]')).toBeNull();
    expect(container.querySelector('[data-testid="deliberation-brain-b"]')).toBeNull();
    expect(container.querySelector('[data-testid="deliberation-max-rounds"]')).toBeNull();
  });

  it("reveals the work-brain note, review-brain pickers + maxRounds when the toggle is turned on", async () => {
    await renderForm(makeAgent(), vi.fn());

    click(container.querySelector('[data-testid="deliberation-enabled-toggle"]'));
    await flushReact();

    expect(container.querySelector('[data-testid="deliberation-config"]')).not.toBeNull();
    // The work brain (A) is the agent itself — a static note, no pickers.
    expect(container.querySelector('[data-testid="deliberation-brain-a"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="deliberation-brain-a-adapter"]')).toBeNull();
    expect(container.querySelector('[data-testid="deliberation-brain-b"]')).not.toBeNull();
    // Only the review brain (B) has an adapter picker, defaulting to inherit ("").
    const brainBAdapter = container.querySelector('[data-testid="deliberation-brain-b-adapter"]') as HTMLSelectElement | null;
    expect(brainBAdapter).not.toBeNull();
    expect(brainBAdapter!.value).toBe("");
    // WC-XADAPT: every available LOCAL adapter is offered (cross-vendor review),
    // alongside the inherit option ("") — not just claude/codex.
    const brainBOptionValues = Array.from(brainBAdapter!.options).map((o) => o.value);
    expect(brainBOptionValues[0]).toBe(""); // inherit is first
    expect(brainBOptionValues).toContain("claude_local");
    expect(brainBOptionValues).toContain("codex_local");
    expect(brainBOptionValues.length).toBeGreaterThanOrEqual(3); // inherit + ≥2 adapters
    const maxRounds = container.querySelector('[data-testid="deliberation-max-rounds"]') as HTMLInputElement | null;
    expect(maxRounds).not.toBeNull();
    // Default maxRounds is 4.
    expect(maxRounds!.value).toBe("4");
  });

  it("includes deliberation (incl. per-brain adapter) in the submitted update payload", async () => {
    const onSave = vi.fn();
    await renderForm(makeAgent(), onSave);

    click(container.querySelector('[data-testid="deliberation-enabled-toggle"]'));
    await flushReact();

    // The review brain can run cross-adapter; the work brain is the agent
    // itself (no picker), so brainA stays inherit/null in the payload.
    setSelectValue(
      container.querySelector('[data-testid="deliberation-brain-b-adapter"]') as HTMLSelectElement,
      "claude_local",
    );
    await flushReact();

    const maxRounds = container.querySelector('[data-testid="deliberation-max-rounds"]') as HTMLInputElement;
    setInputValue(maxRounds, "6");
    await flushReact();

    // The form exposes a sticky Save button when dirty.
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save",
    );
    expect(saveButton, "expected a Save button once the form is dirty").not.toBeUndefined();
    click(saveButton);
    await flushReact();

    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch).toHaveProperty("deliberation");
    expect(patch.deliberation).toMatchObject({
      enabled: true,
      maxRounds: 6,
      // Review-brain adapter flows into the payload; the work brain stays
      // inherit (= the agent itself); models stay null (inherit).
      brainA: { adapter: null, model: null },
      brainB: { adapter: "claude_local", model: null },
    });
  });

  it("WC-PANEL/WC-TRACK: panel mode swaps in the panel editor and submits members + track", async () => {
    const onSave = vi.fn();
    await renderForm(makeAgent(), onSave);

    click(container.querySelector('[data-testid="deliberation-enabled-toggle"]'));
    await flushReact();

    // Switch to panel review → the single brainB picker is hidden, the panel
    // editor appears.
    setSelectValue(container.querySelector('[data-testid="deliberation-review-mode"]') as HTMLSelectElement, "panel");
    await flushReact();
    expect(container.querySelector('[data-testid="deliberation-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="deliberation-brain-b"]')).toBeNull();

    // Add one panel member and give it a cross-vendor adapter.
    click(container.querySelector('[data-testid="deliberation-panel-add"]'));
    await flushReact();
    const member0Adapter = container.querySelector('[data-testid="deliberation-panel-member-0-adapter"]') as HTMLSelectElement;
    expect(member0Adapter).not.toBeNull();
    setSelectValue(member0Adapter, "codex_local");
    await flushReact();

    // Focus the review on artifacts (Track A).
    setSelectValue(container.querySelector('[data-testid="deliberation-track"]') as HTMLSelectElement, "a");
    await flushReact();

    const saveButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Save");
    click(saveButton);
    await flushReact();

    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch.deliberation).toMatchObject({
      enabled: true,
      reviewMode: "panel",
      track: "a",
      panel: { members: [{ adapter: "codex_local", model: null }] },
    });
  });

  it("seeds the section (incl. per-brain adapter) from an agent that already has deliberation configured", async () => {
    await renderForm(
      makeAgent({
        deliberation: {
          enabled: true,
          // WC-208: stored cross-adapter brains seed the adapter selects.
          brainA: { adapter: "claude_local", model: "anthropic/claude-x" },
          brainB: { adapter: "codex_local", model: "openai/gpt-y" },
          maxRounds: 7,
        },
      }),
      vi.fn(),
    );

    // Already enabled → config visible without toggling.
    expect(container.querySelector('[data-testid="deliberation-config"]')).not.toBeNull();
    const maxRounds = container.querySelector('[data-testid="deliberation-max-rounds"]') as HTMLInputElement;
    expect(maxRounds.value).toBe("7");
    // The review-brain select reflects the stored adapter; a stored brainA is
    // legacy (the work brain is the agent itself) and gets no picker.
    expect(container.querySelector('[data-testid="deliberation-brain-a-adapter"]')).toBeNull();
    const brainBAdapter = container.querySelector('[data-testid="deliberation-brain-b-adapter"]') as HTMLSelectElement;
    expect(brainBAdapter.value).toBe("codex_local");
  });
});
