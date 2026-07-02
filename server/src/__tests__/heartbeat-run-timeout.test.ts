import { describe, expect, it } from "vitest";
import { resolveRunTimeoutSec } from "../services/heartbeat.js";

// Production-readiness Wave 2 (REL — main-run timeout): a heartbeat run with no
// configured adapter timeout (unset or 0) must get a sane DEFAULT max wall-clock
// so a wedged CLI is killed; an EXPLICIT non-zero agent timeout must be preserved
// verbatim. resolveRunTimeoutSec encodes that default-vs-preserve rule.

const DEFAULT_RUN_TIMEOUT_SEC = 10800;

describe("resolveRunTimeoutSec", () => {
  it("injects the default when timeoutSec is unset", () => {
    expect(resolveRunTimeoutSec(undefined)).toBe(DEFAULT_RUN_TIMEOUT_SEC);
    expect(resolveRunTimeoutSec(null)).toBe(DEFAULT_RUN_TIMEOUT_SEC);
  });

  it("injects the default when timeoutSec is 0 (the adapter 'no kill timer' sentinel)", () => {
    expect(resolveRunTimeoutSec(0)).toBe(DEFAULT_RUN_TIMEOUT_SEC);
  });

  it("injects the default when timeoutSec is negative or non-numeric garbage", () => {
    expect(resolveRunTimeoutSec(-5)).toBe(DEFAULT_RUN_TIMEOUT_SEC);
    expect(resolveRunTimeoutSec("not-a-number")).toBe(DEFAULT_RUN_TIMEOUT_SEC);
    expect(resolveRunTimeoutSec({})).toBe(DEFAULT_RUN_TIMEOUT_SEC);
    // A numeric STRING is not a configured number — the adapters themselves read
    // asNumber(config.timeoutSec, 0), which only accepts real numbers — so a
    // string timeoutSec is treated as unset and gets the default. Matching the
    // adapter's coercion exactly keeps behavior consistent.
    expect(resolveRunTimeoutSec("120")).toBe(DEFAULT_RUN_TIMEOUT_SEC);
  });

  it("PRESERVES an explicit positive numeric agent timeout (never overrides it)", () => {
    expect(resolveRunTimeoutSec(60)).toBe(60);
    expect(resolveRunTimeoutSec(3600)).toBe(3600);
  });

  it("truncates a fractional explicit timeout to whole seconds", () => {
    expect(resolveRunTimeoutSec(90.7)).toBe(90);
  });
});
