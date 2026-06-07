import { describe, expect, it } from "vitest";
import { derivePairTimelineMeta } from "./PairRoundTimeline";

describe("WC-126 derivePairTimelineMeta", () => {
  it("sums costCents across turns", () => {
    expect(
      derivePairTimelineMeta([
        { costCents: 12, metadata: {} },
        { costCents: 8, metadata: {} },
        { costCents: 0, metadata: {} },
      ]).totalCostCents,
    ).toBe(20);
  });

  it("treats missing costCents as 0", () => {
    expect(derivePairTimelineMeta([{ metadata: {} }, { costCents: 5, metadata: {} }]).totalCostCents).toBe(5);
  });

  it("reports liveMode=live when ANY turn ran against a real model", () => {
    expect(
      derivePairTimelineMeta([
        { metadata: { stub: true } },
        { metadata: { live: true, adapterType: "claude_local" } },
      ]).liveMode,
    ).toBe("live");
  });

  it("reports liveMode=simulated when only stub turns exist", () => {
    expect(
      derivePairTimelineMeta([{ metadata: { stub: true } }, { metadata: { stub: true } }]).liveMode,
    ).toBe("simulated");
  });

  it("reports liveMode=null when no turn carries live/stub metadata", () => {
    expect(derivePairTimelineMeta([{ metadata: {} }, { metadata: null }]).liveMode).toBeNull();
    expect(derivePairTimelineMeta([]).liveMode).toBeNull();
  });

  it("returns zero cost + null mode for an empty pair", () => {
    expect(derivePairTimelineMeta([])).toEqual({ totalCostCents: 0, liveMode: null });
  });
});
