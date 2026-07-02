import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { resolveSianHtml } from "../routes/issues.js";

const UUID = "11111111-1111-1111-1111-111111111111";
const HTML = "<!DOCTYPE html><html><body><h1>시안</h1></body></html>";

// A fake storage object whose stream yields the given UTF-8 string.
function streamOf(text: string) {
  return { stream: Readable.from([Buffer.from(text, "utf8")]) };
}

function depsForAsset(asset: {
  companyId: string;
  objectKey: string;
  contentType: string | null;
} | null, body = HTML) {
  return {
    getAsset: vi.fn(async () => asset),
    getObject: vi.fn(async () => streamOf(body)),
  };
}

describe("resolveSianHtml", () => {
  it("decodes a legacy percent-encoded data:text/html url (no asset I/O)", async () => {
    const deps = depsForAsset(null);
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`;
    expect(await resolveSianHtml(deps, url)).toBe(HTML);
    expect(deps.getAsset).not.toHaveBeenCalled();
    expect(deps.getObject).not.toHaveBeenCalled();
  });

  it("decodes a legacy base64 data:text/html url", async () => {
    const deps = depsForAsset(null);
    const url = `data:text/html;base64,${Buffer.from(HTML, "utf8").toString("base64")}`;
    expect(await resolveSianHtml(deps, url)).toBe(HTML);
  });

  it("reads HTML from an absolute asset content url", async () => {
    const deps = depsForAsset({ companyId: "co-1", objectKey: "k/1", contentType: "text/html" });
    const url = `http://localhost:4000/api/assets/${UUID}/content`;
    expect(await resolveSianHtml(deps, url, "co-1")).toBe(HTML);
    expect(deps.getAsset).toHaveBeenCalledWith(UUID);
    expect(deps.getObject).toHaveBeenCalledWith("co-1", "k/1");
  });

  it("reads HTML from a relative asset content url", async () => {
    const deps = depsForAsset({ companyId: "co-1", objectKey: "k/1", contentType: "text/html; charset=utf-8" });
    expect(await resolveSianHtml(deps, `/api/assets/${UUID}/content`, "co-1")).toBe(HTML);
  });

  it("returns null for an asset whose content-type is not html (e.g. a png)", async () => {
    const deps = depsForAsset({ companyId: "co-1", objectKey: "k/1", contentType: "image/png" });
    expect(await resolveSianHtml(deps, `/api/assets/${UUID}/content`, "co-1")).toBeNull();
    expect(deps.getObject).not.toHaveBeenCalled();
  });

  it("returns null when the asset does not exist", async () => {
    const deps = depsForAsset(null);
    expect(await resolveSianHtml(deps, `/api/assets/${UUID}/content`)).toBeNull();
  });

  it("rejects a cross-company asset id (defense-in-depth)", async () => {
    const deps = depsForAsset({ companyId: "other-co", objectKey: "k/1", contentType: "text/html" });
    expect(await resolveSianHtml(deps, `/api/assets/${UUID}/content`, "co-1")).toBeNull();
    expect(deps.getObject).not.toHaveBeenCalled();
  });

  it("allows a matching-company asset, and allows any company when expectedCompanyId is omitted", async () => {
    const deps = depsForAsset({ companyId: "other-co", objectKey: "k/1", contentType: "text/html" });
    expect(await resolveSianHtml(deps, `/api/assets/${UUID}/content`)).toBe(HTML);
  });

  it("returns null (never throws) when the storage read throws", async () => {
    const deps = {
      getAsset: vi.fn(async () => ({ companyId: "co-1", objectKey: "k/1", contentType: "text/html" })),
      getObject: vi.fn(async () => {
        throw new Error("storage exploded");
      }),
    };
    await expect(resolveSianHtml(deps, `/api/assets/${UUID}/content`, "co-1")).resolves.toBeNull();
  });

  it("returns null for a live https link (not a data: url, not an asset url)", async () => {
    const deps = depsForAsset({ companyId: "co-1", objectKey: "k/1", contentType: "text/html" });
    expect(await resolveSianHtml(deps, "https://designs.example/preview", "co-1")).toBeNull();
    expect(deps.getAsset).not.toHaveBeenCalled();
  });

  it("returns null for null / undefined / non-asset urls", async () => {
    const deps = depsForAsset(null);
    expect(await resolveSianHtml(deps, null)).toBeNull();
    expect(await resolveSianHtml(deps, undefined)).toBeNull();
    expect(await resolveSianHtml(deps, "/api/assets/not-a-uuid/content")).toBeNull();
  });
});
