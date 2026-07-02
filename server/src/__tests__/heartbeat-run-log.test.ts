import { describe, expect, it } from "vitest";
import { compactRunLogChunk } from "../services/heartbeat.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[workcell truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("elides the body of an oversized data:text/html 시안 url (keeps it from flooding the log)", () => {
    const body = encodeURIComponent("<!DOCTYPE html><html>" + "<div>x</div>".repeat(5000) + "</html>");
    const chunk = `Parent work product: @{id=abc; url=data:text/html;charset=utf-8,${body}; type=design}`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(body);
    expect(compacted).toContain("data:text/html;charset=utf-8,");
    expect(compacted).toContain(`omitted data: url body: ${body.length} chars`);
    // The surrounding fields survive — only the blob is elided.
    expect(compacted).toContain("id=abc");
    expect(compacted).toContain("type=design");
  });

  it("leaves a small data: url (e.g. a tiny icon) untouched", () => {
    const small = "data:image/svg+xml,%3Csvg%3E%3C/svg%3E";
    expect(compactRunLogChunk(`icon: ${small}`)).toContain(small);
  });

  it("redacts Workcell credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export WORKCELL_API_KEY='workcell-shell-secret'`,
      `payload {"WORKCELL_API_KEY":"workcell-json-secret"}`,
      "--workcell-api-key=workcell-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("workcell-shell-secret");
    expect(compacted).not.toContain("workcell-json-secret");
    expect(compacted).not.toContain("workcell-flag-secret");
  });
});
