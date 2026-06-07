// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { quotaConfidence, quotaConfidenceLabel } from "./utils";

// WC-20 (PLAN §9 #8): the tri-state Exact/Synced/Estimated mapping is the
// product surface for "how trustworthy is this quota number?" — it needs
// stable classification so visual treatment stays consistent over time.
describe("quotaConfidence", () => {
  it("classifies provider real-time API sources as Exact", () => {
    expect(quotaConfidence("anthropic-oauth")).toBe("exact");
    expect(quotaConfidence("claude-cli")).toBe("exact");
    expect(quotaConfidence("codex-rpc")).toBe("exact");
  });

  it("classifies periodically-synced sources as Synced", () => {
    expect(quotaConfidence("codex-wham")).toBe("synced");
    expect(quotaConfidence("bedrock")).toBe("synced");
  });

  it("falls back to Estimated for unknown, missing, or empty sources", () => {
    expect(quotaConfidence(null)).toBe("estimated");
    expect(quotaConfidence(undefined)).toBe("estimated");
    expect(quotaConfidence("")).toBe("estimated");
    expect(quotaConfidence("some-future-provider")).toBe("estimated");
  });

  it("maps each confidence to a stable human label", () => {
    expect(quotaConfidenceLabel("exact")).toBe("Exact");
    expect(quotaConfidenceLabel("synced")).toBe("Synced");
    expect(quotaConfidenceLabel("estimated")).toBe("Estimated");
  });
});
