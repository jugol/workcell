import { describe, expect, it } from "vitest";
import { resolveCompareTarget } from "../src/ui/compare.js";

// WC-119/120: the version list is sorted newest-first.
describe("resolveCompareTarget (Open Design version compare)", () => {
  const versions = ["v3-newest", "v2", "v1-oldest"];

  it("returns the next-older version for a newer row (diff runs older -> newer)", () => {
    expect(resolveCompareTarget(versions, 0)).toBe("v2");
    expect(resolveCompareTarget(versions, 1)).toBe("v1-oldest");
  });

  it("returns null for the OLDEST row (nothing older to diff)", () => {
    // The pre-WC-119 bug returned versions[idx-1] here — a NEWER artifact —
    // which inverted the diff. Must be null so no Compare button is shown.
    expect(resolveCompareTarget(versions, 2)).toBeNull();
  });

  it("returns null for a single-version group", () => {
    expect(resolveCompareTarget(["only"], 0)).toBeNull();
  });

  it("returns null for empty / out-of-range indices", () => {
    expect(resolveCompareTarget([], 0)).toBeNull();
    expect(resolveCompareTarget(versions, -1)).toBeNull();
    expect(resolveCompareTarget(versions, 99)).toBeNull();
  });
});
