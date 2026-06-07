import { Command } from "commander";
import { readFile } from "node:fs/promises";
import pc from "picocolors";
import {
  addCommonClientOptions,
  handleCommandError,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

// WC-183b / (b)2: the "스캔" front-end for design-system ingestion. The backend
// (POST /issues/:id/design-system { html, title? }) extracts design tokens
// (colors/typography/spacing) + a light component inventory and stores a
// design-type work product. This command captures a UI's HTML and POSTs it.
//
// Two capture sources, exactly one required:
//   --html <file> : read an HTML file from disk. The reliable path — always works.
//   --url  <url>  : capture a live page's RENDERED HTML via a headless browser.
//                   Playwright is in the repo's dev deps (e2e) but is NOT a
//                   guaranteed CLI runtime dep, so we load it with a DYNAMIC
//                   import and degrade gracefully: if Playwright (or its browser)
//                   can't load/launch, we print an actionable message and exit
//                   non-zero rather than crashing with a stack trace.

interface DesignScanOptions extends BaseClientOptions {
  issue?: string;
  html?: string;
  url?: string;
  title?: string;
}

// The token shape echoed back by the route under `designSystem` (mirrors the
// server's DesignSystem interface — only the fields we summarize are typed).
interface DesignSystemTokens {
  colors?: unknown[];
  fontFamilies?: unknown[];
  fontSizes?: unknown[];
  spacing?: unknown[];
  componentCounts?: unknown[];
}

interface DesignSystemScanResponse {
  workProduct?: { id?: string; title?: string };
  designSystem?: DesignSystemTokens;
}

export interface DesignTokenSummary {
  colors: number;
  fontFamilies: number;
  fontSizes: number;
  spacing: number;
  components: number;
}

// Pure, total: count the extracted token sets for a concise post-scan summary.
// Tolerant of missing/garbage arrays so a partial response still summarizes.
export function summarizeDesignSystem(designSystem: DesignSystemTokens | undefined): DesignTokenSummary {
  const len = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  return {
    colors: len(designSystem?.colors),
    fontFamilies: len(designSystem?.fontFamilies),
    fontSizes: len(designSystem?.fontSizes),
    spacing: len(designSystem?.spacing),
    components: len(designSystem?.componentCounts),
  };
}

export type DesignCaptureSource =
  | { kind: "html"; file: string }
  | { kind: "url"; url: string };

// Validate that EXACTLY one of --html / --url is provided. Pure + throwing so
// the action surfaces a clear validation error before any file/network/browser
// work — and so the rule is unit-testable without a command harness.
export function resolveCaptureSource(opts: { html?: string; url?: string }): DesignCaptureSource {
  const html = opts.html?.trim();
  const url = opts.url?.trim();
  if (html && url) {
    throw new Error("Pass exactly one of --html <file> or --url <url>, not both.");
  }
  if (!html && !url) {
    throw new Error("A capture source is required: pass --html <file> or --url <url>.");
  }
  return html ? { kind: "html", file: html } : { kind: "url", url: url as string };
}

export const HEADLESS_UNAVAILABLE_MESSAGE =
  "Headless capture unavailable — install Playwright browsers (`pnpm exec playwright install chromium`), or pass --html <file>.";

// Thrown when --url capture cannot proceed because Playwright (or its browser)
// is not available. Carries an actionable message; the action turns it into a
// clean non-zero exit instead of a stack trace.
export class HeadlessUnavailableError extends Error {
  constructor(message = HEADLESS_UNAVAILABLE_MESSAGE, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HeadlessUnavailableError";
  }
}

// Minimal structural type of the bits of `@playwright/test` we use. Playwright
// is NOT a hard dependency of the CLI, so we never import its types directly.
interface PlaywrightChromiumLauncher {
  launch(options?: { headless?: boolean }): Promise<{
    newPage(): Promise<{
      goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
      content(): Promise<string>;
    }>;
    close(): Promise<void>;
  }>;
}

// DYNAMIC import of the headless browser. Playwright ships in the repo's dev
// dependencies as `@playwright/test` (used by e2e), but is not a guaranteed CLI
// runtime dep — so `await import(...)` may reject (module absent) and even when
// the module loads, launching may throw if the browser binary isn't installed.
// Either failure becomes a HeadlessUnavailableError. Injectable for tests.
export type ChromiumLoader = () => Promise<PlaywrightChromiumLauncher>;

const defaultChromiumLoader: ChromiumLoader = async () => {
  const mod = (await import("@playwright/test")) as { chromium?: PlaywrightChromiumLauncher };
  if (!mod?.chromium) {
    throw new HeadlessUnavailableError();
  }
  return mod.chromium;
};

// Capture a live page's rendered HTML. Loads Playwright dynamically, launches
// headless chromium, navigates, reads page.content() (the rendered DOM), then
// closes the browser. Any load/launch failure degrades to HeadlessUnavailableError.
export async function captureHtmlFromUrl(
  url: string,
  loadChromium: ChromiumLoader = defaultChromiumLoader,
): Promise<string> {
  let chromium: PlaywrightChromiumLauncher;
  try {
    chromium = await loadChromium();
  } catch (err) {
    throw new HeadlessUnavailableError(HEADLESS_UNAVAILABLE_MESSAGE, { cause: err });
  }

  let browser: Awaited<ReturnType<PlaywrightChromiumLauncher["launch"]>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    return await page.content();
  } catch (err) {
    // A failed launch usually means the browser binary isn't installed; surface
    // the same actionable guidance rather than a raw Playwright stack trace.
    throw new HeadlessUnavailableError(HEADLESS_UNAVAILABLE_MESSAGE, { cause: err });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

// Resolve a capture source into the HTML string we POST. Reads from disk for
// --html (utf-8) or drives the headless browser for --url.
export async function captureHtml(
  source: DesignCaptureSource,
  loadChromium?: ChromiumLoader,
): Promise<string> {
  if (source.kind === "html") {
    try {
      return await readFile(source.file, "utf8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read HTML file ${source.file}: ${reason}`);
    }
  }
  return captureHtmlFromUrl(source.url, loadChromium);
}

export async function designScanCommand(opts: DesignScanOptions, loadChromium?: ChromiumLoader): Promise<void> {
  try {
    const issueId = opts.issue?.trim();
    if (!issueId) {
      throw new Error("An issue id is required: pass --issue <issueId>.");
    }

    // Validate the capture source up front (clear error on both/neither) so we
    // never do file/network work for an invalid invocation.
    const source = resolveCaptureSource(opts);

    const ctx = resolveCommandContext(opts);

    let html: string;
    try {
      html = await captureHtml(source, loadChromium);
    } catch (err) {
      if (err instanceof HeadlessUnavailableError) {
        // Graceful degradation: actionable message + non-zero exit, no stack trace.
        console.error(pc.red(err.message));
        process.exit(1);
      }
      throw err;
    }

    const title = opts.title?.trim() || undefined;
    const payload = title ? { html, title } : { html };
    const response = await ctx.api.post<DesignSystemScanResponse>(
      `/api/issues/${issueId}/design-system`,
      payload,
    );

    if (ctx.json) {
      console.log(JSON.stringify(response, null, 2));
      return;
    }

    const summary = summarizeDesignSystem(response?.designSystem);
    const workProductId = response?.workProduct?.id ?? "(unknown)";
    console.log(
      pc.green(
        `Scanned design system → work product ${workProductId}: ` +
          `${summary.colors} colors, ${summary.fontFamilies} font families, ` +
          `${summary.fontSizes} font sizes, ${summary.spacing} spacing tokens, ` +
          `${summary.components} components.`,
      ),
    );
  } catch (err) {
    handleCommandError(err);
  }
}

export function registerDesignCommands(program: Command): void {
  const design = program
    .command("design")
    .description("Design-system operations (scan an existing UI into design tokens)");

  addCommonClientOptions(
    design
      .command("scan")
      .description(
        "Capture a UI's HTML (from --html <file> or, if a headless browser is available, --url <url>) " +
          "and ingest it as a design system on an issue",
      )
      .requiredOption("--issue <issueId>", "Issue ID to attach the extracted design system to")
      .option("--html <file>", "Path to an HTML file to scan (the reliable capture path)")
      .option("--url <url>", "URL to capture rendered HTML from via a headless browser (if available)")
      .option("--title <title>", "Optional title for the stored design-system work product")
      .action(async (opts: DesignScanOptions) => {
        await designScanCommand(opts);
      }),
  );
}
