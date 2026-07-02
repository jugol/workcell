import { describe, expect, it } from "vitest";
import { buildCodexExecArgs } from "./codex-args.js";

describe("buildCodexExecArgs", () => {
  it("enables Codex fast mode overrides for GPT-5.4", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "--search",
      "exec",
      "--json",
      "--model",
      "gpt-5.4",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("enables Codex fast mode overrides for manual models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.5",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.fastModeIgnoredReason).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.5",
      "-c",
      'service_tier="fast"',
      "-c",
      "features.fast_mode=true",
      "-",
    ]);
  });

  it("ignores fast mode for unsupported models", () => {
    const result = buildCodexExecArgs({
      model: "gpt-5.3-codex",
      fastMode: true,
    });

    expect(result.fastModeRequested).toBe(true);
    expect(result.fastModeApplied).toBe(false);
    expect(result.fastModeIgnoredReason).toContain(
      "currently only supported on gpt-5.4 or manually configured model IDs",
    );
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex",
      "-",
    ]);
  });

  it("appends --image for each designer 시안 self-review image path", () => {
    const result = buildCodexExecArgs(
      { model: "gpt-5.3-codex" },
      { imagePaths: ["/abs/preview-a.png", "/abs/preview-b.png"] },
    );

    // --image flags must come BEFORE the trailing `-` prompt-source positional.
    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex",
      "--image",
      "/abs/preview-a.png",
      "--image",
      "/abs/preview-b.png",
      "-",
    ]);
  });

  it("places --image before the resume positional on a resumed session", () => {
    const result = buildCodexExecArgs(
      { model: "gpt-5.3-codex" },
      { imagePaths: ["/abs/preview.png"], resumeSessionId: "sess-123" },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.3-codex",
      "--image",
      "/abs/preview.png",
      "resume",
      "sess-123",
      "-",
    ]);
  });

  it("adds no --image flags when no image paths are present (byte-identical)", () => {
    const withEmpty = buildCodexExecArgs({ model: "gpt-5.3-codex" }, { imagePaths: [] });
    const withBlank = buildCodexExecArgs({ model: "gpt-5.3-codex" }, { imagePaths: ["", "   "] });
    const without = buildCodexExecArgs({ model: "gpt-5.3-codex" });

    const expected = ["exec", "--json", "--model", "gpt-5.3-codex", "-"];
    expect(withEmpty.args).toEqual(expected);
    expect(withBlank.args).toEqual(expected);
    expect(without.args).toEqual(expected);
  });

  it("adds --skip-git-repo-check when requested", () => {
    const result = buildCodexExecArgs(
      {
        model: "gpt-5.3-codex",
      },
      { skipGitRepoCheck: true },
    );

    expect(result.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.3-codex",
      "-",
    ]);
  });
});
