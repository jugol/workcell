// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanguageSelect } from "./LanguageSelect";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("LanguageSelect", () => {
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

  it("renders a locale picker listing many languages, including English and Korean", () => {
    act(() => {
      root.render(<LanguageSelect />);
    });
    const select = container.querySelector("select");
    expect(select).toBeTruthy();
    const values = Array.from(select!.options).map((option) => option.value);
    expect(values).toContain("en");
    expect(values).toContain("ko");
    // The seed ships 40 locale files; the picker should list well beyond a handful.
    expect(values.length).toBeGreaterThan(5);
  });
});
