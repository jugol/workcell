// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntityRow } from "./EntityRow";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("EntityRow keyboard accessibility (onClick-only row)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("exposes a focusable button role on an onClick-only row", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<EntityRow title="Clickable row" onClick={() => {}} />);
    });

    const row = container.querySelector('[role="button"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute("tabindex")).toBe("0");

    act(() => {
      root.unmount();
    });
  });

  it("activates onClick via Enter and Space keys", () => {
    const onClick = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<EntityRow title="Clickable row" onClick={onClick} />);
    });

    const row = container.querySelector<HTMLDivElement>('[role="button"]');
    expect(row).not.toBeNull();

    act(() => {
      row!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    act(() => {
      row!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });

    expect(onClick).toHaveBeenCalledTimes(2);

    act(() => {
      root.unmount();
    });
  });

  it("ignores unrelated keys", () => {
    const onClick = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<EntityRow title="Clickable row" onClick={onClick} />);
    });

    const row = container.querySelector<HTMLDivElement>('[role="button"]');
    act(() => {
      row!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });

    expect(onClick).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("does not add button semantics to a link (to-mode) row", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<EntityRow title="Linked row" to="/somewhere" />);
    });

    // Link branch renders an <a>, not a role=button div.
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(container.querySelector("a")).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });
});
