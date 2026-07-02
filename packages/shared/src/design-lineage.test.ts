import { describe, expect, it } from "vitest";
import {
  normalizeDesignLineageTitle,
  designLineageDisplayTitle,
} from "./design-lineage.js";

describe("design lineage grouping", () => {
  it("collapses explicit v-version siblings to one lineage key", () => {
    // The reported real-world pair must share a key.
    const a = normalizeDesignLineageTitle("LORO 한국어 앱 — 핵심 화면 시안 v2.1");
    const b = normalizeDesignLineageTitle("LORO 한국어 앱 — 핵심 화면 시안 v2");
    expect(a).toBe(b);
  });

  it("keeps distinctly-titled boards as separate lineages", () => {
    const titles = [
      "시안 대비 앱 화면 정합성 구현 기준 시안 v3",
      "LOR-83 화면별 시안 보드 v8",
      "관리자 JSON 편집 화면 v2",
      "LORO 한국어 앱 — 핵심 화면 시안 v2.1",
      "LORO 한국어 앱 — 핵심 화면 시안 v2",
    ];
    const keys = new Set(titles.map(normalizeDesignLineageTitle));
    // The LORO pair collapses; the other three stay singletons → 4 lineages.
    expect(keys.size).toBe(4);
  });

  it("does NOT treat a bare trailing number as a version (WC-199)", () => {
    // "Dashboard 2024" and "Onboarding Step 2" are distinct screens.
    expect(normalizeDesignLineageTitle("Dashboard 2024")).not.toBe(
      normalizeDesignLineageTitle("Dashboard 2023"),
    );
    expect(normalizeDesignLineageTitle("Onboarding Step 2")).toBe("onboarding step 2");
  });

  it("displayTitle strips the version suffix but preserves case", () => {
    expect(designLineageDisplayTitle("Login 시안 v2")).toBe("Login 시안");
    expect(designLineageDisplayTitle("Login 시안")).toBe("Login 시안");
  });

  it("falls back to the original when stripping empties the title", () => {
    expect(normalizeDesignLineageTitle("v2")).toBe("v2");
    expect(designLineageDisplayTitle("v2")).toBe("v2");
  });
});
