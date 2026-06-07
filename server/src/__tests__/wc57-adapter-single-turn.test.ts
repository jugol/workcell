import { describe, expect, it, vi } from "vitest";
import type {
  AdapterAgent,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "../adapters/index.js";
import {
  runAdapterSingleTurn,
  type SingleTurnAdapter,
} from "../services/adapter-single-turn.ts";
import {
  billedCostCentsFromAdapterResult,
  normalizeBilledCostCents,
  normalizeLedgerBillingType,
} from "../services/cost-mapping.ts";

const AGENT: AdapterAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Ada",
  adapterType: "claude_local",
  adapterConfig: {},
};

function fakeResult(over: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    ...over,
  };
}

describe("WC-57 cost-mapping", () => {
  it("normalizeLedgerBillingType maps known + unknown values", () => {
    expect(normalizeLedgerBillingType("api")).toBe("metered_api");
    expect(normalizeLedgerBillingType("metered_api")).toBe("metered_api");
    expect(normalizeLedgerBillingType("subscription")).toBe("subscription_included");
    expect(normalizeLedgerBillingType("subscription_included")).toBe("subscription_included");
    expect(normalizeLedgerBillingType("subscription_overage")).toBe("subscription_overage");
    expect(normalizeLedgerBillingType("credits")).toBe("credits");
    expect(normalizeLedgerBillingType("fixed")).toBe("fixed");
    // WC-68 parity: the original heartbeat normalizer switched on the
    // UNTRIMMED value, so whitespace-padded tokens are NOT recognized and fall
    // through to "unknown" (NOT trimmed-and-matched). This guards the
    // verbatim-extraction contract — esp. that "  subscription  " stays
    // "unknown" (and therefore bills) rather than being zeroed.
    expect(normalizeLedgerBillingType("  api  ")).toBe("unknown");
    expect(normalizeLedgerBillingType("  subscription  ")).toBe("unknown");
    expect(normalizeLedgerBillingType("nonsense")).toBe("unknown");
    expect(normalizeLedgerBillingType(null)).toBe("unknown");
    expect(normalizeLedgerBillingType(undefined)).toBe("unknown");
    expect(normalizeLedgerBillingType(42)).toBe("unknown");
  });

  it("normalizeBilledCostCents rounds, clamps, and zeroes subscription-included", () => {
    expect(normalizeBilledCostCents(0.0123, "metered_api")).toBe(1);
    expect(normalizeBilledCostCents(0.5, "metered_api")).toBe(50);
    expect(normalizeBilledCostCents(1.239, "metered_api")).toBe(124);
    // subscription-included is free at the margin regardless of costUsd
    expect(normalizeBilledCostCents(9.99, "subscription_included")).toBe(0);
    // non-finite / null / negative all clamp to 0
    expect(normalizeBilledCostCents(null, "metered_api")).toBe(0);
    expect(normalizeBilledCostCents(undefined, "metered_api")).toBe(0);
    expect(normalizeBilledCostCents(Number.NaN, "metered_api")).toBe(0);
    expect(normalizeBilledCostCents(-3, "metered_api")).toBe(0);
  });

  it("billedCostCentsFromAdapterResult combines normalization + cost mapping", () => {
    expect(billedCostCentsFromAdapterResult({ costUsd: 0.42, billingType: "api" })).toBe(42);
    // subscription billing → 0 even with a cost
    expect(billedCostCentsFromAdapterResult({ costUsd: 0.42, billingType: "subscription" })).toBe(0);
    // missing fields → 0
    expect(billedCostCentsFromAdapterResult({})).toBe(0);
  });
});

describe("WC-57 runAdapterSingleTurn", () => {
  it("resolves the adapter, accumulates stdout/stderr, and returns the raw result", async () => {
    let capturedCtx: AdapterExecutionContext | null = null;
    const canned = fakeResult({ usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.25 });
    const fakeAdapter: SingleTurnAdapter = {
      execute: vi.fn(async (ctx: AdapterExecutionContext) => {
        capturedCtx = ctx;
        await ctx.onLog("stdout", "Hello ");
        await ctx.onLog("stdout", "world");
        await ctx.onLog("stderr", "a warning");
        return canned;
      }),
    };

    const out = await runAdapterSingleTurn({
      adapterType: "claude_local",
      runId: "run-1",
      agent: AGENT,
      context: { workcellIssue: { id: "i1", title: "T" } },
      authToken: "tok-123",
      resolveAdapter: () => fakeAdapter,
    });

    expect(out.stdout).toBe("Hello world");
    expect(out.stderr).toBe("a warning");
    expect(out.result).toBe(canned);

    // Context assembled with the supplied + defaulted fields.
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.runId).toBe("run-1");
    expect(capturedCtx!.agent).toBe(AGENT);
    expect(capturedCtx!.authToken).toBe("tok-123");
    expect(capturedCtx!.context).toEqual({ workcellIssue: { id: "i1", title: "T" } });
    // runtime + config defaulted (caller passed neither)
    expect(capturedCtx!.config).toEqual({});
    expect(capturedCtx!.runtime).toEqual({
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    });
    expect(capturedCtx!.executionTarget).toBeNull();
  });

  it("maps an adapter result's cost via the shared cost util (integration of both helpers)", async () => {
    const fakeAdapter: SingleTurnAdapter = {
      execute: vi.fn(async (ctx: AdapterExecutionContext) => {
        await ctx.onLog("stdout", "Proposal.\nOUTCOME: delivered");
        return fakeResult({ costUsd: 0.37, billingType: "metered_api" });
      }),
    };
    const out = await runAdapterSingleTurn({
      adapterType: "claude_local",
      runId: "run-2",
      agent: AGENT,
      resolveAdapter: () => fakeAdapter,
    });
    // The pair invoker (WC-58) will feed the raw result into the cost util.
    const cents = billedCostCentsFromAdapterResult({
      costUsd: out.result.costUsd,
      billingType: out.result.billingType,
    });
    expect(cents).toBe(37);
    expect(out.stdout).toContain("OUTCOME: delivered");
  });
});
