import { describe, it, expect } from "vitest";
import { formatCents, formatNumber, formatTokens } from "./utils";

describe("formatCents", () => {
  it("formats finite cents as USD", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(12345)).toBe("$123.45");
    expect(formatCents(100)).toBe("$1.00");
  });

  // WC-152: money must never render "$NaN" — non-finite inputs (null/undefined/
  // NaN can arrive at runtime despite the `number` type) coerce to $0.00.
  it("never renders $NaN for non-finite input", () => {
    expect(formatCents(Number.NaN)).toBe("$0.00");
    expect(formatCents(undefined as unknown as number)).toBe("$0.00");
    expect(formatCents(null as unknown as number)).toBe("$0.00");
    expect(formatCents(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });
});

describe("formatTokens", () => {
  it("humanizes finite token counts", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_000_000)).toBe("2.0M");
  });

  it("never renders NaN/undefined for non-finite input (WC-152)", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(undefined as unknown as number)).toBe("0");
  });
});

describe("formatNumber", () => {
  it("formats finite numbers and guards non-finite (WC-152)", () => {
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatNumber(Number.NaN)).toBe("0");
    expect(formatNumber(undefined as unknown as number)).toBe("0");
  });
});
