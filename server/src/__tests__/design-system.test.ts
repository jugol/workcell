import { describe, expect, it } from "vitest";
import {
  extractDesignSystem,
  renderDesignSystemPreviewHtml,
  designSystemToDataUrl,
  type DesignSystem,
} from "../services/design-system.js";

// WC-183a / D22 / D13: pure unit coverage for the "기존 UI 스캔 → 디자인시스템 추출"
// extractor. extractDesignSystem is PURE/deterministic/TOTAL — these assertions
// pin the exact tokens derived from a representative captured-UI sample, and the
// graceful degradation on empty/garbage input.

// A small but representative captured-UI sample: a <style> block plus inline
// styles, exercising hex (mixed case + shorthand) + rgb colors, font-family /
// font-size, margin / padding / gap (incl. a shorthand), and a handful of tags.
const SAMPLE_HTML = `<!doctype html>
<html>
<head>
<style>
  body { font-family: "Inter", system-ui, sans-serif; color: #1A2B3C; background: #FFF; }
  .btn { font-size: 14px; padding: 8px 16px; margin: 0; background: rgb(255, 0, 0); }
  .title { font-family: Inter, sans-serif; font-size: 24px; color: #1a2b3c; }
  .card { gap: 16px; padding: 24px; }
</style>
</head>
<body>
  <header style="font-size: 32px; color: #fff; margin-bottom: 8px;">Hi</header>
  <nav><a href="#">Home</a><a href="#">About</a></nav>
  <section>
    <button class="btn">Save</button>
    <button class="btn">Cancel</button>
    <input type="text" />
  </section>
</body>
</html>`;

describe("extractDesignSystem (WC-183a)", () => {
  const ds = extractDesignSystem(SAMPLE_HTML);

  it("frequency-counts + normalizes colors, sorted by count desc then value", () => {
    // #1A2B3C + #1a2b3c → #1a2b3c (×2); #FFF + #fff → #fff (×2);
    // rgb(255, 0, 0) → rgb(255,0,0) (×1, whitespace collapsed).
    expect(ds.colors).toEqual([
      { value: "#1a2b3c", count: 2 },
      { value: "#fff", count: 2 },
      { value: "rgb(255,0,0)", count: 1 },
    ]);
    // Deterministic tie-break: equal counts ordered by value ascending.
    expect(ds.colors[0].value < ds.colors[1].value).toBe(true);
  });

  it("collects font families in first-seen order, deduped, quotes stripped", () => {
    expect(ds.fontFamilies).toEqual(["Inter", "system-ui", "sans-serif"]);
  });

  it("collects font sizes, deduped + numerically sorted", () => {
    expect(ds.fontSizes).toEqual(["14px", "24px", "32px"]);
  });

  it("collects spacing tokens from margin/padding/gap incl. shorthand, sorted", () => {
    // 0 has no unit so it is NOT a px/rem token; "8px 16px" shorthand → 8px,16px.
    expect(ds.spacing).toEqual(["8px", "16px", "24px"]);
  });

  it("counts curated component tags, most-used first", () => {
    const counts = Object.fromEntries(ds.componentCounts.map((c) => [c.tag, c.count]));
    expect(counts.button).toBe(2);
    expect(counts.a).toBe(2);
    expect(counts.input).toBe(1);
    expect(counts.nav).toBe(1);
    expect(counts.header).toBe(1);
    expect(counts.section).toBe(1);
    // Sorted by count desc (top entry has the max count).
    expect(ds.componentCounts[0].count).toBe(2);
    // <a> must not be double-counted from "<article"/"<aside" (none here) or
    // swallow other tags; exactly the two anchors.
    expect(ds.componentCounts.find((c) => c.tag === "a")?.count).toBe(2);
  });

  it("summarizes the source", () => {
    expect(ds.sourceSummary.htmlBytes).toBe(SAMPLE_HTML.length);
    expect(ds.sourceSummary.colorCount).toBe(ds.colors.length);
    expect(ds.sourceSummary.colorCount).toBe(3);
  });
});

describe("extractDesignSystem — empty / garbage input is total (WC-183a)", () => {
  const empties: [string, string][] = [
    ["empty string", ""],
    ["whitespace", "   \n\t  "],
    ["plain prose, no css", "the quick brown fox jumps over the lazy dog"],
    ["broken markup", "<<<>>> }{ font-family ;;; #zz not-a-color rgb( )"],
  ];

  for (const [label, html] of empties) {
    it(`returns empty token arrays without throwing: ${label}`, () => {
      let ds!: DesignSystem;
      expect(() => {
        ds = extractDesignSystem(html);
      }).not.toThrow();
      expect(ds.colors).toEqual([]);
      expect(ds.fontFamilies).toEqual([]);
      expect(ds.fontSizes).toEqual([]);
      expect(ds.spacing).toEqual([]);
      expect(ds.componentCounts).toEqual([]);
      expect(ds.sourceSummary.colorCount).toBe(0);
      expect(ds.sourceSummary.htmlBytes).toBe(html.length);
    });
  }

  it("does not throw on non-string input and yields an empty system", () => {
    // Defensive: callers may pass through unvalidated values.
    const ds = extractDesignSystem(undefined as unknown as string);
    expect(ds.colors).toEqual([]);
    expect(ds.sourceSummary.htmlBytes).toBe(0);
  });
});

describe("designSystemToDataUrl (WC-183a)", () => {
  it("starts with the utf-8 data-url prefix and round-trips the preview html", () => {
    const ds = extractDesignSystem(SAMPLE_HTML);
    const url = designSystemToDataUrl(ds);
    const prefix = "data:text/html;charset=utf-8,";
    expect(url.startsWith(prefix)).toBe(true);

    const decoded = decodeURIComponent(url.slice(prefix.length));
    expect(decoded).toBe(renderDesignSystemPreviewHtml(ds));
    expect(decoded.startsWith("<!doctype html>")).toBe(true);
    // The palette + a derived color label render into the preview document.
    expect(decoded).toContain("#1a2b3c");
    expect(decoded).toContain("Type scale");
  });

  it("renders a non-empty preview even for an empty design system", () => {
    const ds = extractDesignSystem("");
    const url = designSystemToDataUrl(ds);
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url).length).toBeGreaterThan(0);
  });
});
