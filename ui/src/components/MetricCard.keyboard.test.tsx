// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LucideIcon } from "lucide-react";
import { MetricCard } from "./MetricCard";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const StubIcon = ((props: React.SVGProps<SVGSVGElement>) => (
  <svg data-testid="stub-icon" {...props} />
)) as unknown as LucideIcon;

describe("MetricCard keyboard accessibility (onClick-only card)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("exposes a focusable button role on an onClick-only card", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<MetricCard icon={StubIcon} value={7} label="Open" onClick={() => {}} />);
    });

    const card = container.querySelector('[role="button"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute("tabindex")).toBe("0");

    act(() => {
      root.unmount();
    });
  });

  it("activates onClick via Enter and Space keys", () => {
    const onClick = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<MetricCard icon={StubIcon} value={7} label="Open" onClick={onClick} />);
    });

    const card = container.querySelector<HTMLDivElement>('[role="button"]');
    expect(card).not.toBeNull();

    act(() => {
      card!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    act(() => {
      card!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });

    expect(onClick).toHaveBeenCalledTimes(2);

    act(() => {
      root.unmount();
    });
  });

  it("does not add button semantics to a link (to-mode) card", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<MetricCard icon={StubIcon} value={7} label="Open" to="/metrics" />);
    });

    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(container.querySelector("a")).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders a plain card with no button semantics when neither to nor onClick is set", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<MetricCard icon={StubIcon} value={7} label="Open" />);
    });

    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(container.querySelector("a")).toBeNull();

    act(() => {
      root.unmount();
    });
  });
});
