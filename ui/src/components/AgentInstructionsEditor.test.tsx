// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentInstructionsEditor } from "./AgentInstructionsEditor";
import type { AgentInstructionsBundle, AgentInstructionsFileDetail } from "@workcell/shared";

// Mock the agents api so the editor renders from fixtures and we can assert the
// save call. Mirrors AgentMemoryTab.test's api-mock approach.
const instructionsBundleMock = vi.hoisted(() => vi.fn());
const instructionsFileMock = vi.hoisted(() => vi.fn());
const saveInstructionsFileMock = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({
  agentsApi: {
    instructionsBundle: (id: string, companyId?: string) => instructionsBundleMock(id, companyId),
    instructionsFile: (id: string, path: string, companyId?: string) =>
      instructionsFileMock(id, path, companyId),
    saveInstructionsFile: (
      id: string,
      data: { path: string; content: string; clearLegacyPromptTemplate?: boolean },
      companyId?: string,
    ) => saveInstructionsFileMock(id, data, companyId),
  },
}));

// Mock the asset upload api (not exercised here, but imported by the component).
vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

// Toast actions spy so the error path is assertable (mirrors IssueDesignReviewPanel.test).
const pushToastMock = vi.hoisted(() => vi.fn());
vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

// Replace the heavyweight markdown editor with a plain textarea so we can type
// deterministically and read the value the component would save.
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      data-testid="instructions-textarea"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeBundle(over: Partial<AgentInstructionsBundle> = {}): AgentInstructionsBundle {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    mode: "managed",
    rootPath: "/root/instructions",
    managedRootPath: "/root/instructions",
    entryFile: "AGENTS.md",
    resolvedEntryPath: "/root/instructions/AGENTS.md",
    editable: true,
    warnings: [],
    legacyPromptTemplateActive: false,
    legacyBootstrapPromptTemplateActive: false,
    files: [
      {
        path: "AGENTS.md",
        size: 12,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
      },
    ],
    ...over,
  };
}

function makeFile(content: string): AgentInstructionsFileDetail {
  return {
    path: "AGENTS.md",
    size: content.length,
    language: "markdown",
    markdown: true,
    isEntryFile: true,
    editable: true,
    deprecated: false,
    virtual: false,
    content,
  };
}

async function flushReact() {
  // Two chained queries (bundle → entry file) each settle on a separate
  // macrotask, so flush several ticks to let both resolve and re-render.
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

/** Lets React detect a DOM value change on controlled textareas (see React #10140). */
function setTextareaValue(el: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  const previous = el.value;
  act(() => {
    valueSetter?.call(el, value);
    const tracker = (el as HTMLTextAreaElement & { _valueTracker?: { setValue: (v: string) => void } })
      ._valueTracker;
    tracker?.setValue(previous);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
}

describe("AgentInstructionsEditor", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    instructionsBundleMock.mockReset();
    instructionsFileMock.mockReset();
    saveInstructionsFileMock.mockReset();
    pushToastMock.mockReset();
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
          <AgentInstructionsEditor agentId="agent-1" companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("loads the current managed instructions content into the editor", async () => {
    instructionsBundleMock.mockResolvedValue(makeBundle());
    instructionsFileMock.mockResolvedValue(makeFile("Behave like a careful reviewer."));
    await mount();

    // Fetches the managed bundle + entry file for this agent.
    expect(instructionsBundleMock).toHaveBeenCalledWith("agent-1", "company-1");
    expect(instructionsFileMock).toHaveBeenCalledWith("agent-1", "AGENTS.md", "company-1");

    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="instructions-textarea"]',
    );
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toBe("Behave like a careful reviewer.");
  });

  it("saves the typed content via saveInstructionsFile (managed entry file)", async () => {
    instructionsBundleMock.mockResolvedValue(makeBundle());
    instructionsFileMock.mockResolvedValue(makeFile("old charter"));
    saveInstructionsFileMock.mockResolvedValue(makeFile("Always respond in Korean."));
    await mount();

    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="instructions-textarea"]',
    )!;

    // Save is disabled until the content actually changes (no-op guard).
    expect(findButton(container, "Save")!.hasAttribute("disabled")).toBe(true);

    setTextareaValue(textarea, "Always respond in Korean.");
    await flushReact();

    const saveButton = findButton(container, "Save")!;
    expect(saveButton.hasAttribute("disabled")).toBe(false);

    act(() => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    expect(saveInstructionsFileMock).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ path: "AGENTS.md", content: "Always respond in Korean." }),
      "company-1",
    );
    // Success path surfaces no error toast.
    expect(pushToastMock).not.toHaveBeenCalled();
  });

  it("shows an error toast when saving fails", async () => {
    instructionsBundleMock.mockResolvedValue(makeBundle());
    instructionsFileMock.mockResolvedValue(makeFile("charter"));
    saveInstructionsFileMock.mockRejectedValue(new Error("network down"));
    await mount();

    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="instructions-textarea"]',
    )!;
    setTextareaValue(textarea, "new behaviour");
    await flushReact();

    act(() => {
      findButton(container, "Save")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await flushReact();

    expect(saveInstructionsFileMock).toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error" }),
    );
  });

  it("hides the inline editor for external-mode bundles and keeps Save disabled", async () => {
    instructionsBundleMock.mockResolvedValue(makeBundle({ mode: "external" }));
    await mount();

    expect(
      container.querySelector('[data-testid="instructions-textarea"]'),
    ).toBeNull();
    // External notice is shown instead; the entry-file content is not fetched.
    expect(instructionsFileMock).not.toHaveBeenCalled();
    expect(findButton(container, "Save")!.hasAttribute("disabled")).toBe(true);
  });
});
