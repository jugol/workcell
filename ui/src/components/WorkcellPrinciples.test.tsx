// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkcellPrinciples, WORKCELL_PRINCIPLES } from "./WorkcellPrinciples";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkcellPrinciples", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the default heading and all four principles", () => {
    act(() => {
      root.render(<WorkcellPrinciples />);
    });
    expect(container.querySelector('[data-testid="workcell-principles"]')).toBeTruthy();
    expect(container.textContent).toContain("How Workcell works");
    for (const principle of WORKCELL_PRINCIPLES) {
      expect(container.textContent).toContain(principle.title);
    }
    // The core promise: proof-gated Done.
    expect(container.textContent).toContain("plan → work → proof");
  });

  it("omits the heading when heading is null but still lists principles", () => {
    act(() => {
      root.render(<WorkcellPrinciples heading={null} />);
    });
    expect(container.textContent).not.toContain("How Workcell works");
    expect(container.textContent).toContain(WORKCELL_PRINCIPLES[0].title);
  });
});
