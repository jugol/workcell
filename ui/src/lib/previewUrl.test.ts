import { describe, it, expect } from "vitest";
import { toDisplayPreviewUrl } from "./previewUrl";

describe("toDisplayPreviewUrl", () => {
  it("strips scheme+host from a baked-in absolute /api/assets url (the 127.0.0.1 refused-to-connect fix)", () => {
    expect(
      toDisplayPreviewUrl("http://127.0.0.1:3100/api/assets/abc-123/content"),
    ).toBe("/api/assets/abc-123/content");
    expect(
      toDisplayPreviewUrl("https://workcell.local:8080/api/assets/x/content?v=2"),
    ).toBe("/api/assets/x/content?v=2");
  });

  it("passes data: urls through unchanged (legacy inline 시안)", () => {
    expect(toDisplayPreviewUrl("data:text/html;charset=utf-8,%3Cdiv%3E")).toBe(
      "data:text/html;charset=utf-8,%3Cdiv%3E",
    );
  });

  it("leaves already-relative urls untouched", () => {
    expect(toDisplayPreviewUrl("/api/assets/x/content")).toBe("/api/assets/x/content");
  });

  it("keeps genuinely external (non-/api) absolute urls absolute", () => {
    expect(toDisplayPreviewUrl("https://example.com/design.png")).toBe(
      "https://example.com/design.png",
    );
  });

  it("returns null for null/empty", () => {
    expect(toDisplayPreviewUrl(null)).toBeNull();
    expect(toDisplayPreviewUrl(undefined)).toBeNull();
    expect(toDisplayPreviewUrl("")).toBeNull();
  });
});
