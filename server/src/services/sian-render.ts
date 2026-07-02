// WC-DSR (designer visual self-review): render a self-contained 시안 (HTML
// mockup) to a PNG with headless Chromium so the DESIGNER agent can be shown a
// rendered screenshot of ITS OWN design on a follow-up run — instead of
// submitting HTML it never saw.
//
// Design notes:
//  - Playwright is imported DYNAMICALLY (not a top-level import) so it is NOT a
//    hard server-startup dependency. A server that never renders a 시안 (or runs
//    on a host without the Chromium binary) boots and serves normally; the cost
//    of the missing browser is paid only when renderSianToPng is actually
//    called, and surfaces as a clear error there.
//  - We launch a fresh browser per call and close it in `finally`. Per-call
//    launch is intentional for now: 시안 renders are infrequent (one per design
//    attach / self-review round, capped at 3 rounds per design) and a shared
//    long-lived browser would add lifecycle/leak complexity to the server for
//    no measurable win. This mirrors scripts/screenshot.cjs.
//  - We render via page.setContent(html) rather than navigating to a data: URL:
//    setContent takes the raw HTML string directly (no size limit / encoding
//    round-trip) and is exactly what a self-contained 시안 needs.
import { logger } from "../middleware/logger.js";

// Sane desktop viewport for a 시안 preview. fullPage screenshots extend BELOW
// this height to capture the whole document; the width is what reflow/layout is
// evaluated against, so it matches the UX team's default desktop review width
// (uxdesigner.md visual-truth gate: 1440x900 desktop).
export const SIAN_RENDER_VIEWPORT = { width: 1440, height: 900 } as const;

// Cap how long we wait for the page to settle. A self-contained mockup has no
// network, so networkidle resolves almost immediately; the timeout only guards
// against a pathological 시안 (e.g. an infinite-loading remote asset).
const SIAN_RENDER_TIMEOUT_MS = 15_000;

export class EmptySianHtmlError extends Error {
  constructor() {
    super("Cannot render an empty 시안: no HTML content was provided.");
    this.name = "EmptySianHtmlError";
  }
}

/**
 * Render a self-contained HTML 시안 to a full-page PNG buffer using headless
 * Chromium. Throws {@link EmptySianHtmlError} for empty/whitespace-only HTML so
 * callers can return a 4xx instead of launching a browser for nothing.
 *
 * The Playwright import is dynamic; if the package or its Chromium binary is
 * unavailable the rejection carries the underlying error message.
 */
export async function renderSianToPng(html: string): Promise<Buffer> {
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new EmptySianHtmlError();
  }

  // Dynamic import keeps Playwright off the server's startup path. `@playwright/test`
  // re-exports the same `chromium` browser type as `playwright`, and it is the
  // package actually installed in this workspace (root devDep + server dep).
  const { chromium } = await import("@playwright/test");

  const browser = await chromium.launch();
  try {
    // CRITICAL — match the BOARD's preview exactly. The board renders the 시안 in
    // a fully-sandboxed iframe (`sandbox=""`, see IssueDesignReviewPanel /
    // DesignSystem / WireframeFlow) which DISABLES JavaScript for security
    // (untrusted agent-authored, same-origin asset HTML must not run scripts).
    // So we render the self-review screenshot with JS DISABLED too: otherwise a
    // 시안 whose content is built by JS (e.g. learning-path nodes injected at
    // runtime) renders fine here (JS on) but EMPTY for the board (JS off) — the
    // designer self-approves a screen the board literally cannot see, and the
    // empty-시안 submit guard never fires. JS-off here surfaces that gap so the
    // designer ships a self-contained, no-script 시안 with static fallback.
    const page = await browser.newPage({
      viewport: { ...SIAN_RENDER_VIEWPORT },
      javaScriptEnabled: false,
    });
    // setContent waits for the load event by default; networkidle additionally
    // waits for fonts/inline-data to settle so the screenshot is not captured
    // mid-paint. A self-contained 시안 has no real network, so this is fast.
    await page.setContent(html, { waitUntil: "networkidle", timeout: SIAN_RENDER_TIMEOUT_MS });
    const buffer = await page.screenshot({ fullPage: true, type: "png" });
    return buffer;
  } finally {
    // Always close the browser, even if setContent/screenshot threw — a leaked
    // Chromium process would accumulate across renders and orphan on shutdown.
    await browser.close().catch((err) => {
      logger.warn({ err }, "failed to close Chromium after 시안 render");
    });
  }
}
