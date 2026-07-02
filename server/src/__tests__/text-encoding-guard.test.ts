import { describe, expect, it, vi } from "vitest";
import {
  buildMojibakeRejection,
  findMojibake,
  findMojibakeDeep,
  mojibakeRequestGuard,
} from "../services/text-encoding-guard.ts";

describe("text-encoding-guard", () => {
  it("accepts clean Korean, emoji, and astral-plane text", () => {
    expect(findMojibake("한국어 학습 튜토리얼 — Agent Setup 계획")).toBeNull();
    expect(findMojibake("emoji 👍 and astral 𝒳 pairs")).toBeNull();
    expect(findMojibake("")).toBeNull();
  });

  it("flags U+FFFD replacement characters (CP949 bytes decoded as UTF-8)", () => {
    // Real-world sample shape from a CP949 shell pipe: Hangul collapses to
    // replacement characters while ASCII survives.
    const corrupted = "# �ө�� Agent Setup ��";
    const finding = findMojibake(corrupted);
    expect(finding).toEqual({ kind: "replacement_character", index: 2 });
  });

  it("flags lone surrogates", () => {
    const loneLow = `abc${String.fromCharCode(0xdcbd)}def`;
    expect(findMojibake(loneLow)).toEqual({ kind: "lone_surrogate", index: 3 });
    const loneHigh = `abc${String.fromCharCode(0xd83d)}def`;
    expect(findMojibake(loneHigh)).toEqual({ kind: "lone_surrogate", index: 3 });
  });

  it("buildMojibakeRejection names the corrupted field and skips clean/empty ones", () => {
    const rejection = buildMojibakeRejection({
      title: "정상 제목",
      body: "broken � body",
      changeSummary: null,
    });
    expect(rejection).not.toBeNull();
    expect(rejection?.code).toBe("mojibake_detected");
    expect(rejection?.field).toBe("body");
    expect(rejection?.error).toContain("UTF-8");

    expect(
      buildMojibakeRejection({ title: "정상", body: "전부 멀쩡한 한국어 본문" }),
    ).toBeNull();
  });

  it("findMojibakeDeep walks nested objects and arrays with a precise path", () => {
    expect(findMojibakeDeep({ a: { b: ["깨끗", "broken �"] } })).toMatchObject({
      path: "body.a.b[1]",
    });
    expect(findMojibakeDeep({ a: [{ b: "전부 정상" }], n: 3, t: true })).toBeNull();
  });

  function runGuard(req: { method: string; path: string; body?: unknown }) {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const next = vi.fn();
    mojibakeRequestGuard()(req, { status }, next);
    return { status, json, next };
  }

  it("middleware rejects mutating bodies with mojibake and names the field", () => {
    const { status, json, next } = runGuard({
      method: "PUT",
      path: "/agents/x/instructions-bundle/file",
      body: { path: "AGENTS.md", content: "You are at �븳湲� tutorial" },
    });
    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0]).toMatchObject({
      code: "mojibake_detected",
      field: "body.content",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("middleware passes clean bodies, GETs, and exempt log/event paths", () => {
    expect(
      runGuard({ method: "PUT", path: "/issues/x/documents/plan", body: { body: "한글 계획" } })
        .next,
    ).toHaveBeenCalled();
    expect(
      runGuard({ method: "GET", path: "/issues/x", body: undefined }).next,
    ).toHaveBeenCalled();
    expect(
      runGuard({ method: "POST", path: "/runs/x/events", body: { chunk: "raw � bytes" } }).next,
    ).toHaveBeenCalled();
  });
});
