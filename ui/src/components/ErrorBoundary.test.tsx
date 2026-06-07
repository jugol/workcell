// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "./ErrorBoundary";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("boom: render failed");
  }
  return <div>safe child content</div>;
}

let container: HTMLDivElement;
let root: Root;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs caught render errors to console.error; silence the expected noise.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  consoleErrorSpy.mockRestore();
});

function renderTree(ui: Parameters<Root["render"]>[0]) {
  act(() => {
    root.render(ui);
  });
}

function text(): string {
  return container.textContent ?? "";
}

function findButton(label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(label),
    ) as HTMLButtonElement | undefined
  ) ?? null;
}

describe("ErrorBoundary", () => {
  it("renders children verbatim on the happy path (pure passthrough)", () => {
    renderTree(
      <ErrorBoundary>
        <div>happy child</div>
      </ErrorBoundary>,
    );
    expect(text()).toContain("happy child");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders the localized fallback (not a blank screen) when a child throws", () => {
    renderTree(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );

    // The crash is contained: the fallback is shown instead of propagating.
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(text()).toContain("Something went wrong");
    expect(findButton("Try again")).not.toBeNull();
    expect(text()).not.toContain("safe child content");
  });

  it("invokes onError with the caught error", () => {
    const onError = vi.fn();
    renderTree(
      <ErrorBoundary onError={onError}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("boom: render failed");
  });

  it("recovers via 'Try again' once the child stops throwing", () => {
    renderTree(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(text()).toContain("Something went wrong");

    // The underlying condition is fixed, but the boundary still shows the
    // fallback until it is reset.
    renderTree(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(text()).not.toContain("safe child content");

    act(() => {
      findButton("Try again")!.click();
    });
    expect(text()).toContain("safe child content");
    expect(text()).not.toContain("Something went wrong");
  });

  it("auto-resets when a resetKey changes (e.g. route navigation)", () => {
    renderTree(
      <ErrorBoundary resetKeys={["/PAP/issues/1"]}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(text()).toContain("Something went wrong");

    // Navigating to a different, healthy route: the key changes and the child
    // no longer throws, so the boundary recovers without an explicit retry.
    renderTree(
      <ErrorBoundary resetKeys={["/PAP/dashboard"]}>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(text()).toContain("safe child content");
    expect(text()).not.toContain("Something went wrong");
  });

  it("uses a custom fallback render prop when provided", () => {
    renderTree(
      <ErrorBoundary fallback={({ error }) => <div>custom: {error.message}</div>}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(text()).toContain("custom: boom: render failed");
    // Default fallback chrome is not rendered.
    expect(text()).not.toContain("Something went wrong");
  });
});
