// WC-183a / D22 / D13: extract a design system from a captured UI sample and
// store it as an Open Design artifact (the source of truth for an existing
// project's design).
//
// The Open Design 시안 is the SOURCE OF TRUTH. For an EXISTING project we do not
// have the original design file — we have the realized UI. This module is the
// "기존 UI 스캔 → 디자인시스템 추출" core: given a captured UI sample (HTML — the
// realistic artifact of a scan), it extracts the design tokens (colors,
// typography, spacing) plus a light component inventory, deterministically and
// without any heavyweight dependency.
//
// PURE + dependency-light by design: NO headless browser, NO CSS parser. We do
// regex/string extraction over the HTML — both inline `style="…"` attributes and
// `<style>…</style>` blocks. The live-URL headless capture is a separate later
// slice (b)2 and is intentionally out of scope here.
//
// extractDesignSystem is PURE, deterministic, and TOTAL: it never throws. Empty
// or garbage input yields empty arrays (and a sourceSummary that reflects the raw
// byte length), so a route can hand it any client payload safely.

export interface DesignSystem {
  // Distinct color literals found anywhere in the HTML (inline styles, <style>
  // blocks, presentational attributes), normalized + frequency-counted.
  colors: { value: string; count: number }[];
  // Font stacks from `font-family:` declarations (first-seen order preserved).
  fontFamilies: string[];
  // `font-size:` values (px/rem/em/%), numerically sorted where possible.
  fontSizes: string[];
  // Numeric px/rem spacing values from margin/padding/gap (incl. shorthands).
  spacing: string[];
  // Light component inventory: counts of a curated HTML tag set.
  componentCounts: { tag: string; count: number }[];
  sourceSummary: { htmlBytes: number; colorCount: number };
}

// ── Caps (keep the extracted token set small + presentable) ─────────────────
const MAX_COLORS = 24;
const MAX_FONT_FAMILIES = 12;
const MAX_FONT_SIZES = 16;
const MAX_SPACING = 16;

// Curated tag set for the light component inventory. We count semantic +
// interactive structural elements that meaningfully describe a UI's component
// makeup; we deliberately skip ultra-generic wrappers like <div>/<span> which
// would swamp the signal.
const COMPONENT_TAGS = [
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "form",
  "a",
  "nav",
  "header",
  "footer",
  "main",
  "aside",
  "section",
  "article",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
  "svg",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "dialog",
] as const;

// Color literals. Three independent families, each matched globally:
//   - hex: #rgb | #rrggbb | #rrggbbaa  (also tolerates #rgba 4-digit shorthand)
//   - rgb()/rgba()
//   - hsl()/hsla()
const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const RGB_COLOR_RE = /rgba?\(\s*[0-9.]+%?\s*,\s*[0-9.]+%?\s*,\s*[0-9.]+%?\s*(?:,\s*[0-9.]+%?\s*)?\)/gi;
const HSL_COLOR_RE = /hsla?\(\s*[0-9.]+(?:deg)?\s*,\s*[0-9.]+%\s*,\s*[0-9.]+%\s*(?:,\s*[0-9.]+%?\s*)?\)/gi;

// Declaration value capture (works on inline styles AND <style> rule bodies).
// A declaration value runs until the next `;` or the closing `}` of the rule
// block; we tolerate quotes inside it (font stacks quote multi-word faces) and
// strip them per-token afterward.
const FONT_FAMILY_RE = /font-family\s*:\s*([^;}]+)/gi;
const FONT_SIZE_RE = /font-size\s*:\s*([0-9.]+(?:px|rem|em|%))/gi;
// margin / padding / gap (incl. -top/-left/… and row-gap/column-gap), capturing
// the whole declaration value so shorthands ("8px 16px") contribute every token.
const SPACING_RE = /(?:margin|padding)(?:-(?:top|right|bottom|left))?\s*:\s*([^;}]+)/gi;
const GAP_RE = /(?:(?:row|column)-)?gap\s*:\s*([^;}]+)/gi;
// A single numeric length token inside a (possibly shorthand) spacing value.
const LENGTH_TOKEN_RE = /-?[0-9]*\.?[0-9]+(?:px|rem)\b/gi;

/** Normalize a color literal for de-duplication: lowercase; collapse inner
 *  whitespace in rgb()/hsl() so `rgb(0, 0,0)` and `rgb(0,0,0)` count as one. */
function normalizeColor(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.startsWith("#")) return lower;
  // Functional notation: drop all internal spaces for a canonical form.
  return lower.replace(/\s+/g, "");
}

/** Parse the leading numeric magnitude of a length/size token (px/rem/em/%),
 *  for numeric sorting. Returns NaN when there is no leading number. */
function numericMagnitude(value: string): number {
  const match = /-?\d*\.?\d+/.exec(value);
  return match ? Number.parseFloat(match[0]) : Number.NaN;
}

/** Stable sort of size-like string tokens: numerically ascending where both are
 *  numeric, otherwise lexicographically. */
function sortBySize(values: string[]): string[] {
  return [...values].sort((a, b) => {
    const na = numericMagnitude(a);
    const nb = numericMagnitude(b);
    const aNum = !Number.isNaN(na);
    const bNum = !Number.isNaN(nb);
    if (aNum && bNum) {
      if (na !== nb) return na - nb;
      return a.localeCompare(b);
    }
    if (aNum) return -1;
    if (bNum) return 1;
    return a.localeCompare(b);
  });
}

function extractColors(html: string): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  const tally = (re: RegExp) => {
    for (const m of html.matchAll(re)) {
      const value = normalizeColor(m[0]);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  };
  tally(HEX_COLOR_RE);
  tally(RGB_COLOR_RE);
  tally(HSL_COLOR_RE);

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    // Frequency desc, then value asc for a deterministic tie-break.
    .sort((a, b) => (b.count - a.count) || a.value.localeCompare(b.value))
    .slice(0, MAX_COLORS);
}

function extractFontFamilies(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(FONT_FAMILY_RE)) {
    // A font-family value is a comma-separated stack; record each face once,
    // stripping wrapping quotes and surrounding whitespace, preserving the
    // first-seen order across the whole document.
    for (const part of m[1].split(",")) {
      const face = part.trim().replace(/^['"]|['"]$/g, "").trim();
      if (!face) continue;
      if (seen.has(face)) continue;
      seen.add(face);
      out.push(face);
      if (out.length >= MAX_FONT_FAMILIES) return out;
    }
  }
  return out;
}

function extractFontSizes(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(FONT_SIZE_RE)) {
    seen.add(m[1].trim().toLowerCase());
  }
  return sortBySize([...seen]).slice(0, MAX_FONT_SIZES);
}

function extractSpacing(html: string): string[] {
  const seen = new Set<string>();
  const harvest = (re: RegExp) => {
    for (const m of html.matchAll(re)) {
      // The captured declaration value may be a shorthand ("8px 16px 8px");
      // pull each numeric px/rem token out of it.
      for (const token of m[1].matchAll(LENGTH_TOKEN_RE)) {
        seen.add(token[0].toLowerCase());
      }
    }
  };
  harvest(SPACING_RE);
  harvest(GAP_RE);
  return sortBySize([...seen]).slice(0, MAX_SPACING);
}

function extractComponentCounts(html: string): { tag: string; count: number }[] {
  const out: { tag: string; count: number }[] = [];
  for (const tag of COMPONENT_TAGS) {
    // Count opening tags: `<tag` followed by whitespace, `>`, or `/` (covers
    // `<a href>`, `<br/>`, `<section>`), case-insensitive. Word-boundary-ish via
    // the trailing char class so `<article` does not match `<a`.
    const re = new RegExp(`<${tag}(?=[\\s/>])`, "gi");
    const count = (html.match(re) ?? []).length;
    if (count > 0) out.push({ tag, count });
  }
  // Most-used components first; deterministic tie-break by tag name.
  return out.sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
}

/**
 * Extract a design system from a captured UI sample (HTML).
 *
 * PURE, deterministic, and TOTAL — never throws. Non-string / empty / garbage
 * input degrades gracefully to empty token arrays.
 */
export function extractDesignSystem(html: string): DesignSystem {
  const source = typeof html === "string" ? html : "";
  const colors = extractColors(source);
  return {
    colors,
    fontFamilies: extractFontFamilies(source),
    fontSizes: extractFontSizes(source),
    spacing: extractSpacing(source),
    componentCounts: extractComponentCounts(source),
    sourceSummary: { htmlBytes: source.length, colorCount: colors.length },
  };
}

// ── Preview rendering ───────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render a self-contained dark, system-ui HTML document that visualizes the
 * extracted design system: color swatches (with hex/literal labels), the
 * font-size scale as live samples, and spacing bars. This becomes the design
 * artifact's preview (served as a data URL).
 */
export function renderDesignSystemPreviewHtml(ds: DesignSystem): string {
  const swatches = ds.colors.length
    ? ds.colors
        .map(
          (c) =>
            `<figure class="swatch"><span class="chip" style="background:${escapeHtml(
              c.value,
            )}"></span><figcaption>${escapeHtml(c.value)}<small>×${c.count}</small></figcaption></figure>`,
        )
        .join("")
    : `<p class="empty">No colors detected.</p>`;

  const families = ds.fontFamilies.length
    ? `<ul class="families">${ds.fontFamilies
        .map((f) => `<li style="font-family:${escapeHtml(f)}">${escapeHtml(f)}</li>`)
        .join("")}</ul>`
    : `<p class="empty">No font families detected.</p>`;

  const sizes = ds.fontSizes.length
    ? ds.fontSizes
        .map(
          (s) =>
            `<div class="size-row"><span class="size-label">${escapeHtml(
              s,
            )}</span><span class="size-sample" style="font-size:${escapeHtml(
              s,
            )}">Ag</span></div>`,
        )
        .join("")
    : `<p class="empty">No font sizes detected.</p>`;

  const spacing = ds.spacing.length
    ? ds.spacing
        .map(
          (s) =>
            `<div class="space-row"><span class="space-label">${escapeHtml(
              s,
            )}</span><span class="space-bar" style="width:${escapeHtml(s)}"></span></div>`,
        )
        .join("")
    : `<p class="empty">No spacing detected.</p>`;

  const components = ds.componentCounts.length
    ? `<ul class="components">${ds.componentCounts
        .map((c) => `<li>&lt;${escapeHtml(c.tag)}&gt;<small>×${c.count}</small></li>`)
        .join("")}</ul>`
    : `<p class="empty">No components detected.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Design System (extracted)</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: #0b0e14;
    color: #e6e9ef;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.4;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #8b93a7; font-size: 13px; margin: 0 0 24px; }
  section { margin-bottom: 32px; }
  h2 {
    font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;
    color: #8b93a7; border-bottom: 1px solid #1c2230; padding-bottom: 6px; margin: 0 0 16px;
  }
  .empty { color: #6b7280; font-style: italic; }
  .swatches { display: flex; flex-wrap: wrap; gap: 12px; }
  .swatch { margin: 0; width: 96px; }
  .chip {
    display: block; height: 64px; border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.12);
  }
  figcaption { font-size: 12px; margin-top: 6px; word-break: break-all; }
  figcaption small { display: block; color: #8b93a7; }
  .families { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
  .families li { font-size: 18px; padding: 8px 12px; background: #11151f; border-radius: 6px; }
  .size-row, .space-row { display: flex; align-items: center; gap: 16px; margin-bottom: 10px; }
  .size-label, .space-label {
    width: 72px; flex: none; color: #8b93a7; font-size: 12px; font-variant-numeric: tabular-nums;
  }
  .size-sample { line-height: 1; }
  .space-bar { display: inline-block; height: 16px; background: #4f86f7; border-radius: 4px; min-width: 2px; }
  .components { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 8px; }
  .components li {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    padding: 6px 10px; background: #11151f; border-radius: 6px;
  }
  .components small { color: #8b93a7; margin-left: 6px; }
</style>
</head>
<body>
  <h1>Design System</h1>
  <p class="meta">${ds.sourceSummary.colorCount} colors · ${ds.fontFamilies.length} font families · ${ds.fontSizes.length} sizes · ${ds.spacing.length} spacing tokens · ${ds.sourceSummary.htmlBytes.toLocaleString("en-US")} bytes scanned</p>

  <section>
    <h2>Colors</h2>
    <div class="swatches">${swatches}</div>
  </section>

  <section>
    <h2>Font families</h2>
    ${families}
  </section>

  <section>
    <h2>Type scale</h2>
    ${sizes}
  </section>

  <section>
    <h2>Spacing</h2>
    ${spacing}
  </section>

  <section>
    <h2>Components</h2>
    ${components}
  </section>
</body>
</html>`;
}

/**
 * Encode the preview document as a data URL. `charset=utf-8` is REQUIRED so the
 * non-ASCII characters used in the preview (·, ×, …) survive the round trip.
 */
export function designSystemToDataUrl(ds: DesignSystem): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(renderDesignSystemPreviewHtml(ds))}`;
}
