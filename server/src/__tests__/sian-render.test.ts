import { describe, expect, it } from "vitest";
import { EmptySianHtmlError, SIAN_RENDER_VIEWPORT, renderSianToPng } from "../services/sian-render.js";

// WC-DSR (designer visual self-review): the 시안 → PNG render service. The empty
// guard is pure and always tested. The real Chromium render is gated behind
// playwright availability so CI hosts without the browser binary skip it rather
// than fail (the guard logic is the load-bearing regression surface here).

describe("renderSianToPng — empty-html guard", () => {
  it("rejects undefined / non-string html", async () => {
    await expect(renderSianToPng(undefined as unknown as string)).rejects.toBeInstanceOf(
      EmptySianHtmlError,
    );
    await expect(renderSianToPng(123 as unknown as string)).rejects.toBeInstanceOf(
      EmptySianHtmlError,
    );
  });

  it("rejects empty / whitespace-only html before launching a browser", async () => {
    await expect(renderSianToPng("")).rejects.toBeInstanceOf(EmptySianHtmlError);
    await expect(renderSianToPng("   \n\t  ")).rejects.toBeInstanceOf(EmptySianHtmlError);
  });

  it("exposes a sane desktop review viewport", () => {
    expect(SIAN_RENDER_VIEWPORT).toEqual({ width: 1440, height: 900 });
  });
});

// Resolve whether playwright + its Chromium binary are usable on this host. When
// not, the real-render test is skipped (not failed) — matching the brief's
// guidance that the actual launch may be skipped in CI.
async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const canRender = await chromiumAvailable();
const describeRender = canRender ? describe : describe.skip;

if (!canRender) {
  console.warn("Skipping renderSianToPng Chromium render test: playwright/Chromium unavailable on this host");
}

describeRender("renderSianToPng — real render", () => {
  it("renders non-empty HTML to a PNG buffer", async () => {
    const html =
      '<!doctype html><html><body style="background:#0a84ff;margin:0">' +
      '<h1 style="color:#fff;font-size:48px;padding:40px">시안</h1></body></html>';
    const buffer = await renderSianToPng(html);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    // PNG magic bytes: 0x89 'P' 'N' 'G'.
    expect(buffer[0]).toBe(0x89);
    expect(buffer.subarray(1, 4).toString("latin1")).toBe("PNG");
  }, 30_000);
});
