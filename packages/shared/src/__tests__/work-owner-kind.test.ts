import { describe, expect, it } from "vitest";
import { ISSUE_WORK_OWNER_KINDS, type IssueWorkOwnerKind } from "../constants.js";

// WC-23 (P2 §3 first slice): smoke test for the new WorkOwner constant.
// The schema is "single" | "pair" — anything else means a typo somewhere
// in a future PairGroup slice that this baseline catches early.
describe("ISSUE_WORK_OWNER_KINDS", () => {
  it("contains exactly the two reserved values in stable order", () => {
    expect(ISSUE_WORK_OWNER_KINDS).toEqual(["single", "pair"]);
  });

  it("derives a usable union type", () => {
    const single: IssueWorkOwnerKind = "single";
    const pair: IssueWorkOwnerKind = "pair";
    expect(ISSUE_WORK_OWNER_KINDS).toContain(single);
    expect(ISSUE_WORK_OWNER_KINDS).toContain(pair);
  });
});
