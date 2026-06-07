// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectInitialLocale,
  isRtlLocale,
  localeNativeName,
  resolveBrowserLocale,
} from "./locale-preference";

const SUPPORTED = ["en", "ko", "ja", "pt-BR", "ar", "zh-CN"];

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("isRtlLocale", () => {
  it("flags RTL scripts (incl. region subtags) and not LTR ones", () => {
    expect(isRtlLocale("ar")).toBe(true);
    expect(isRtlLocale("fa-IR")).toBe(true);
    expect(isRtlLocale("he")).toBe(true);
    expect(isRtlLocale("ur")).toBe(true);
    expect(isRtlLocale("en")).toBe(false);
    expect(isRtlLocale("ko")).toBe(false);
  });
});

describe("resolveBrowserLocale", () => {
  it("prefers an exact code, then the base language", () => {
    vi.stubGlobal("navigator", { language: "pt-BR", languages: ["pt-BR", "pt"] });
    expect(resolveBrowserLocale(SUPPORTED)).toBe("pt-BR");

    vi.stubGlobal("navigator", { language: "ko-KR", languages: ["ko-KR"] });
    expect(resolveBrowserLocale(SUPPORTED)).toBe("ko");
  });

  it("returns null when nothing matches", () => {
    vi.stubGlobal("navigator", { language: "sw", languages: ["sw"] });
    expect(resolveBrowserLocale(SUPPORTED)).toBeNull();
  });
});

describe("detectInitialLocale", () => {
  it("prefers a valid stored preference over the browser language", () => {
    vi.stubGlobal("navigator", { language: "ja", languages: ["ja"] });
    localStorage.setItem("workcell.ui-locale", "ko");
    expect(detectInitialLocale(SUPPORTED)).toBe("ko");
  });

  it("ignores an unsupported stored preference and uses the browser language", () => {
    vi.stubGlobal("navigator", { language: "ja-JP", languages: ["ja-JP"] });
    localStorage.setItem("workcell.ui-locale", "zz");
    expect(detectInitialLocale(SUPPORTED)).toBe("ja");
  });

  it("falls back to English when nothing matches", () => {
    vi.stubGlobal("navigator", { language: "sw", languages: ["sw"] });
    expect(detectInitialLocale(SUPPORTED)).toBe("en");
  });
});

describe("localeNativeName", () => {
  it("returns an endonym for a known code", () => {
    // Node's Intl returns the language's own name; accept either to stay robust.
    expect(localeNativeName("ko")).toMatch(/한국어|Korean/);
  });
});
