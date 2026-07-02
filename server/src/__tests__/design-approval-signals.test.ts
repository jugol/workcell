import { describe, expect, it } from "vitest";
import type { IssueWorkProduct } from "@workcell/shared";
import {
  approvalPayloadRequestsDesignReviewApproval,
  designWorkProductIdsApprovedByBoardApproval,
} from "../services/design-approval-signals.ts";

// A board approval can carry the design-review decision. These helpers detect a
// design-review approval payload and resolve which current 시안 (design work
// product) it approves, so approving the board approval clears the design gate.
function design(id: string, overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id,
    companyId: "c1",
    issueId: "i1",
    type: "design",
    provider: "workcell",
    title: `design ${id}`,
    status: "active",
    reviewState: "needs_board_review",
    isPrimary: true,
    screenKey: "home",
    screenName: "Home",
    url: `https://x/${id}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as unknown as IssueWorkProduct;
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("design-approval-signals", () => {
  describe("approvalPayloadRequestsDesignReviewApproval", () => {
    it("detects a design-review approval request", () => {
      expect(
        approvalPayloadRequestsDesignReviewApproval({
          summary: "Please approve the design review for the 시안 (mockup).",
        }),
      ).toBe(true);
    });

    it("ignores an unrelated (non-design) approval", () => {
      expect(
        approvalPayloadRequestsDesignReviewApproval({
          summary: "Approve the quarterly budget increase.",
        }),
      ).toBe(false);
    });
  });

  describe("designWorkProductIdsApprovedByBoardApproval", () => {
    it("approves the design referenced by id in the payload", () => {
      const ids = designWorkProductIdsApprovedByBoardApproval(
        [design(A, { screenKey: "home" }), design(B, { screenKey: "settings" })],
        [{ summary: `approve the design review 시안 work-product ${A}` }],
      );
      expect(ids.has(A)).toBe(true);
      expect(ids.has(B)).toBe(false);
    });

    it("approves the single design when the request carries no explicit ref", () => {
      const ids = designWorkProductIdsApprovedByBoardApproval(
        [design(A)],
        [{ summary: "approve the design review 시안 (source-of-truth mockup)" }],
      );
      expect(ids.has(A)).toBe(true);
    });

    it("approves nothing for an unrelated approval", () => {
      const ids = designWorkProductIdsApprovedByBoardApproval(
        [design(A)],
        [{ summary: "approve the quarterly budget" }],
      );
      expect(ids.size).toBe(0);
    });

    it("approves nothing when the issue has no design work products", () => {
      const ids = designWorkProductIdsApprovedByBoardApproval(
        [],
        [{ summary: "approve the design review 시안 mockup" }],
      );
      expect(ids.size).toBe(0);
    });
  });
});
