import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// WC-183b: tests for the `workcell design scan` command. Hermetic — we mock the
// HTTP client (via resolveCommandContext) and, for the --url failure path, the
// headless browser loader. No real browser is launched and no network is hit.

// Capture the POST calls the command makes through the authenticated client.
const postMock = vi.fn();

// Mock the shared client common module so resolveCommandContext returns a stub
// api whose `post` we can assert on, without building a real WorkcellApiClient
// or touching auth/context/network. addCommonClientOptions/handleCommandError
// keep their real behavior (handleCommandError exits non-zero via process.exit).
vi.mock("../commands/client/common.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/client/common.js")>();
  return {
    ...actual,
    resolveCommandContext: vi.fn(() => ({
      api: { post: postMock },
      companyId: undefined,
      profileName: "default",
      profile: {},
      json: false,
    })),
  };
});

import {
  designScanCommand,
  resolveCaptureSource,
  summarizeDesignSystem,
  HeadlessUnavailableError,
  HEADLESS_UNAVAILABLE_MESSAGE,
  type ChromiumLoader,
} from "../commands/client/design.js";

const tempDirs: string[] = [];

async function makeHtmlFile(html: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wc183b-design-scan-"));
  tempDirs.push(dir);
  const file = path.join(dir, "page.html");
  await writeFile(file, html, "utf8");
  return file;
}

// A stubbed { workProduct, designSystem } response mirroring the route shape.
const STUB_RESPONSE = {
  workProduct: { id: "wp-123", title: "Design System (extracted)" },
  designSystem: {
    colors: [{ value: "#fff", count: 3 }, { value: "#000", count: 1 }],
    fontFamilies: ["Inter", "system-ui"],
    fontSizes: ["14px", "24px", "32px"],
    spacing: ["8px"],
    componentCounts: [{ tag: "button", count: 2 }],
  },
};

let exitSpy: MockInstance<(code?: number) => never>;
let logSpy: MockInstance<(...args: unknown[]) => void>;
let errSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  postMock.mockReset();
  // process.exit must not kill the test runner; throw a sentinel we can catch
  // and assert the non-zero code on.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never) as MockInstance<(code?: number) => never>;
  logSpy = vi
    .spyOn(console, "log")
    .mockImplementation(() => undefined) as unknown as MockInstance<(...args: unknown[]) => void>;
  errSpy = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined) as unknown as MockInstance<(...args: unknown[]) => void>;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("summarizeDesignSystem (WC-183b)", () => {
  it("counts colors/fontFamilies/fontSizes/spacing/components", () => {
    expect(summarizeDesignSystem(STUB_RESPONSE.designSystem)).toEqual({
      colors: 2,
      fontFamilies: 2,
      fontSizes: 3,
      spacing: 1,
      components: 1,
    });
  });

  it("is total — missing/garbage arrays count as 0", () => {
    expect(summarizeDesignSystem(undefined)).toEqual({
      colors: 0,
      fontFamilies: 0,
      fontSizes: 0,
      spacing: 0,
      components: 0,
    });
    expect(summarizeDesignSystem({ colors: "nope" as unknown as unknown[] })).toEqual({
      colors: 0,
      fontFamilies: 0,
      fontSizes: 0,
      spacing: 0,
      components: 0,
    });
  });
});

describe("resolveCaptureSource (WC-183b)", () => {
  it("accepts --html alone", () => {
    expect(resolveCaptureSource({ html: "a.html" })).toEqual({ kind: "html", file: "a.html" });
  });
  it("accepts --url alone", () => {
    expect(resolveCaptureSource({ url: "https://x.test" })).toEqual({
      kind: "url",
      url: "https://x.test",
    });
  });
  it("rejects both --html and --url", () => {
    expect(() => resolveCaptureSource({ html: "a.html", url: "https://x.test" })).toThrow(
      /exactly one/i,
    );
  });
  it("rejects neither", () => {
    expect(() => resolveCaptureSource({})).toThrow(/capture source is required/i);
  });
});

describe("design scan --html (WC-183b)", () => {
  it("reads the HTML file and POSTs { html, title } to /issues/:id/design-system, printing the token summary", async () => {
    const html = "<html><body><button>Go</button></body></html>";
    const file = await makeHtmlFile(html);
    postMock.mockResolvedValue(STUB_RESPONSE);

    await designScanCommand({ issue: "issue-1", html: file, title: "My System" });

    expect(postMock).toHaveBeenCalledTimes(1);
    const [route, body] = postMock.mock.calls[0] as [string, { html: string; title?: string }];
    expect(route).toBe("/api/issues/issue-1/design-system");
    expect(body).toEqual({ html, title: "My System" });

    // Concise summary: work product id + token counts from the stubbed response.
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("wp-123");
    expect(printed).toContain("2 colors");
    expect(printed).toContain("2 font families");
    expect(printed).toContain("3 font sizes");
    expect(printed).toContain("1 spacing tokens");
    expect(printed).toContain("1 components");
  });

  it("omits title from the payload when not provided", async () => {
    const html = "<html></html>";
    const file = await makeHtmlFile(html);
    postMock.mockResolvedValue(STUB_RESPONSE);

    await designScanCommand({ issue: "issue-1", html: file });

    const [, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toEqual({ html });
    expect(body).not.toHaveProperty("title");
  });
});

describe("design scan validation (WC-183b)", () => {
  it("errors and does NOT POST when both --html and --url are given", async () => {
    await expect(
      designScanCommand({ issue: "issue-1", html: "a.html", url: "https://x.test" }),
    ).rejects.toThrow(/process\.exit:1/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("errors and does NOT POST when neither --html nor --url is given", async () => {
    await expect(designScanCommand({ issue: "issue-1" })).rejects.toThrow(/process\.exit:1/);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("errors and does NOT POST when --issue is missing", async () => {
    await expect(designScanCommand({ html: "a.html" })).rejects.toThrow(/process\.exit:1/);
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe("design scan --url graceful degradation (WC-183b)", () => {
  it("when the headless import/launch fails → actionable message + non-zero exit, no crash, no POST", async () => {
    // Simulate Playwright (or its browser) being unavailable: the dynamic loader rejects.
    const failingLoader: ChromiumLoader = vi.fn(async () => {
      throw new Error("Cannot find module '@playwright/test'");
    });

    await expect(
      designScanCommand({ issue: "issue-1", url: "https://example.test" }, failingLoader),
    ).rejects.toThrow(/process\.exit:1/);

    // process.exit(1), not a thrown stack trace from Playwright.
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The actionable guidance was printed to stderr.
    const printedErr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printedErr).toContain(HEADLESS_UNAVAILABLE_MESSAGE);
    // No design-system POST happened — we never captured HTML.
    expect(postMock).not.toHaveBeenCalled();
  });

  it("HeadlessUnavailableError carries the actionable default message", () => {
    expect(new HeadlessUnavailableError().message).toBe(HEADLESS_UNAVAILABLE_MESSAGE);
  });
});
