import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, issueWorkProducts, issues } from "@workcell/db";
import type { IssueWorkProduct } from "@workcell/shared";
import {
  DESIGN_REVIEW_STATES,
  DESIGN_WORK_PRODUCT_TYPES,
  deriveIssueDesignGate,
  isValidDesignReviewTransition,
  workProductService,
} from "../services/work-products.ts";
import {
  DESIGN_WORK_PRODUCT_TYPES as SHARED_DESIGN_WORK_PRODUCT_TYPES,
  isDesignWorkProductType as sharedIsDesignWorkProductType,
} from "@workcell/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function createWorkProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-17T00:00:00.000Z");
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 1",
    url: "https://example.com/pr/1",
    status: "open",
    reviewState: "draft",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("workProductService", () => {
  it("uses a transaction when creating a new primary work product", async () => {
    const updatedWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updatedWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const insertedRow = createWorkProductRow();
    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = {
      update: txUpdate,
      insert: txInsert,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.createForIssue("issue-1", "company-1", {
      type: "pull_request",
      provider: "github",
      title: "PR 1",
      status: "open",
      reviewState: "draft",
      isPrimary: true,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe("work-product-1");
  });

  it("uses a transaction when promoting an existing work product to primary", async () => {
    const existingRow = createWorkProductRow({ isPrimary: false });

    const selectWhere = vi.fn(async () => [existingRow]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const txSelect = vi.fn(() => ({ from: selectFrom }));

    const updateReturning = vi
      .fn()
      .mockResolvedValue([createWorkProductRow({ reviewState: "ready_for_review" })]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = {
      select: txSelect,
      update: txUpdate,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.update("work-product-1", {
      isPrimary: true,
      reviewState: "ready_for_review",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(result?.reviewState).toBe("ready_for_review");
  });
});

// WC-182 / D22: the isPrimary design-type work product is the issue's
// source-of-truth design; reviewState is its review gate. These exercise the
// real per-type primary-uniqueness + review-gate behaviour against embedded
// Postgres (mirrors the WC-3/WC-40 embedded-pg setup).
describe("isValidDesignReviewTransition (WC-182/D22)", () => {
  it("allows the design-review gate transitions and rejects the rest", () => {
    // valid forward/back transitions
    expect(isValidDesignReviewTransition("none", "needs_board_review")).toBe(true);
    expect(isValidDesignReviewTransition("needs_board_review", "approved")).toBe(true);
    expect(isValidDesignReviewTransition("needs_board_review", "changes_requested")).toBe(true);
    expect(isValidDesignReviewTransition("changes_requested", "needs_board_review")).toBe(true);
    expect(isValidDesignReviewTransition("approved", "needs_board_review")).toBe(true);
    // any state → itself is an allowed no-op
    for (const s of DESIGN_REVIEW_STATES) {
      expect(isValidDesignReviewTransition(s, s)).toBe(true);
    }
    // representative invalid transitions
    expect(isValidDesignReviewTransition("none", "approved")).toBe(false);
    expect(isValidDesignReviewTransition("none", "changes_requested")).toBe(false);
    expect(isValidDesignReviewTransition("approved", "changes_requested")).toBe(false);
    expect(isValidDesignReviewTransition("changes_requested", "approved")).toBe(false);
  });
});

// WC-182f / D22: the design gate drives development. deriveIssueDesignGate is a
// pure projection of an issue's work products into the agent-facing wake signal:
// approved authoritative design → build against it; an unapproved source-of-truth
// design → developmentHold + a HOLD directive. These exercise every branch with
// in-memory IssueWorkProduct fixtures (no DB needed — the helper is pure).
function makeWorkProduct(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  const now = new Date("2026-05-01T00:00:00.000Z");
  return {
    id: "wp-1",
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    // Open-enum text in issue_work_products.type, outside the narrow union → cast.
    type: "design" as IssueWorkProduct["type"],
    provider: "workcell",
    externalId: null,
    title: "Login screen design",
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("deriveIssueDesignGate (WC-182f/D22)", () => {
  it("approved authoritative design → approved, no hold, build-against-it directive", () => {
    const gate = deriveIssueDesignGate([
      makeWorkProduct({
        title: "Checkout flow",
        url: "https://figma.com/file/abc",
        isPrimary: true,
        reviewState: "approved",
      }),
    ]);
    expect(gate.hasDesign).toBe(true);
    expect(gate.approved).toBe(true);
    expect(gate.developmentHold).toBe(false);
    expect(gate.authoritativeDesign).toEqual({
      id: "wp-1",
      title: "Checkout flow",
      url: "https://figma.com/file/abc",
      reviewState: "approved",
    });
    expect(gate.directive).toContain("approved source-of-truth design");
    expect(gate.directive).toContain('"Checkout flow"');
    expect(gate.directive).toContain("https://figma.com/file/abc");
    expect(gate.directive).toContain("Build and verify against it");
    expect(gate.directive).not.toContain("HOLD");
  });

  it("needs_board_review authoritative design → developmentHold with a HOLD directive", () => {
    const gate = deriveIssueDesignGate([
      makeWorkProduct({ title: "Pending design", isPrimary: true, reviewState: "needs_board_review" }),
    ]);
    expect(gate.hasDesign).toBe(true);
    expect(gate.approved).toBe(false);
    expect(gate.developmentHold).toBe(true);
    expect(gate.authoritativeDesign?.reviewState).toBe("needs_board_review");
    expect(gate.directive).toContain("HOLD development");
    expect(gate.directive).toContain("needs_board_review");
    expect(gate.directive).toContain('"Pending design"');
  });

  it("changes_requested authoritative design also holds development", () => {
    const gate = deriveIssueDesignGate([
      makeWorkProduct({ isPrimary: true, reviewState: "changes_requested" }),
    ]);
    expect(gate.developmentHold).toBe(true);
    expect(gate.approved).toBe(false);
    expect(gate.directive).toContain("HOLD development");
  });

  it("designs present but none is the source of truth → no hold, designate directive", () => {
    const gate = deriveIssueDesignGate([
      makeWorkProduct({ id: "d1", isPrimary: false, reviewState: "none", title: "Variant A" }),
      makeWorkProduct({ id: "d2", isPrimary: false, reviewState: "none", title: "Variant B" }),
    ]);
    expect(gate.hasDesign).toBe(true);
    expect(gate.authoritativeDesign).toBeNull();
    expect(gate.approved).toBe(false);
    expect(gate.developmentHold).toBe(false);
    expect(gate.directive).toContain("none is marked the source-of-truth design");
    expect(gate.directive).toContain("designate");
  });

  it("ignores a non-design primary (e.g. a primary proof) when finding the authoritative design", () => {
    const gate = deriveIssueDesignGate([
      makeWorkProduct({ id: "p1", type: "proof" as IssueWorkProduct["type"], isPrimary: true, reviewState: "approved" }),
    ]);
    // A primary proof is not a design → no design at all from the gate's view.
    expect(gate.hasDesign).toBe(false);
    expect(gate.authoritativeDesign).toBeNull();
    expect(gate.developmentHold).toBe(false);
    expect(gate.directive).toBe("");
  });

  it("no designs → hasDesign false, no hold, empty directive", () => {
    const gate = deriveIssueDesignGate([]);
    expect(gate.hasDesign).toBe(false);
    expect(gate.authoritativeDesign).toBeNull();
    expect(gate.approved).toBe(false);
    expect(gate.developmentHold).toBe(false);
    expect(gate.directive).toBe("");
  });

  it("approved authoritative design with no url omits the url from the directive", () => {
    const gate = deriveIssueDesignGate([
      makeWorkProduct({ title: "No-URL design", url: null, isPrimary: true, reviewState: "approved" }),
    ]);
    expect(gate.approved).toBe(true);
    expect(gate.directive).toContain('"No-URL design"');
    expect(gate.directive).not.toContain("http");
    expect(gate.directive).not.toContain("()");
  });
});

// WC-182d / D22: the design-type set is centralized in @workcell/shared and the
// server's design-artifact-types module re-exports it. Assert the shared package
// is the source of truth (same tuple + working type guard) so server and UI
// stay in lockstep.
describe("@workcell/shared design-type exports (WC-182d/D22)", () => {
  it("exports DESIGN_WORK_PRODUCT_TYPES as the canonical design-type set", () => {
    expect([...SHARED_DESIGN_WORK_PRODUCT_TYPES]).toEqual([
      "design",
      "ui_preview",
      "mockup",
      "screenshot",
      "figma_frame",
    ]);
    // The server service re-exports the same identity from shared.
    expect([...DESIGN_WORK_PRODUCT_TYPES]).toEqual([...SHARED_DESIGN_WORK_PRODUCT_TYPES]);
  });

  it("isDesignWorkProductType accepts design types and rejects others", () => {
    for (const t of SHARED_DESIGN_WORK_PRODUCT_TYPES) {
      expect(sharedIsDesignWorkProductType(t)).toBe(true);
    }
    expect(sharedIsDesignWorkProductType("proof")).toBe(false);
    expect(sharedIsDesignWorkProductType("document")).toBe(false);
    expect(sharedIsDesignWorkProductType("")).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-182 source-of-truth design embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regenerated per test so the shared embedded-Postgres DB stays collision-free
// and order-independent.
let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("source-of-truth design (WC-182/D22)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof workProductService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let issueId: string;

  async function addWorkProduct(
    overrides: Partial<typeof issueWorkProducts.$inferInsert> & {
      type: string;
    },
  ) {
    const [row] = await db
      .insert(issueWorkProducts)
      .values({
        companyId,
        issueId,
        provider: "workcell",
        title: `${overrides.type} artifact`,
        status: "active",
        ...overrides,
      })
      .returning();
    return row;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc182-source-of-truth-design-");
    db = createDb(tempDb.connectionString);
    svc = workProductService(db);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Design parent",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
    });
  });

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("getAuthoritativeDesignForIssue", () => {
    it("returns null when the issue has no primary design", async () => {
      // A non-primary design product exists, but nothing is authoritative yet.
      await addWorkProduct({ type: "design", isPrimary: false });
      const result = await svc.getAuthoritativeDesignForIssue(issueId, companyId);
      expect(result).toBeNull();
    });

    it("returns the primary design once one is set", async () => {
      const design = await addWorkProduct({ type: "ui_preview", isPrimary: true });
      const result = await svc.getAuthoritativeDesignForIssue(issueId, companyId);
      expect(result?.id).toBe(design.id);
      expect(result?.isPrimary).toBe(true);
      expect(result?.type).toBe("ui_preview");
    });

    it("ignores a non-design-type primary (e.g. a primary proof)", async () => {
      // A primary proof must NOT be treated as the source-of-truth design.
      await addWorkProduct({ type: "proof", isPrimary: true });
      const result = await svc.getAuthoritativeDesignForIssue(issueId, companyId);
      expect(result).toBeNull();
    });
  });

  describe("setAuthoritativeDesign", () => {
    it("makes a design product authoritative and unsets a prior authoritative design of the same type", async () => {
      const first = await addWorkProduct({ type: "design", isPrimary: true });
      const second = await addWorkProduct({ type: "design", isPrimary: false });

      const updated = await svc.setAuthoritativeDesign(second.id);
      expect(updated.id).toBe(second.id);
      expect(updated.isPrimary).toBe(true);

      // Per-type uniqueness: the previously authoritative design is no longer primary.
      const firstAfter = await svc.getById(first.id);
      expect(firstAfter?.isPrimary).toBe(false);

      // The issue's authoritative design is now the second one.
      const authoritative = await svc.getAuthoritativeDesignForIssue(issueId, companyId);
      expect(authoritative?.id).toBe(second.id);
    });

    it("throws when the work product is not a design type", async () => {
      const proof = await addWorkProduct({ type: "proof", isPrimary: false });
      await expect(svc.setAuthoritativeDesign(proof.id)).rejects.toThrow(/not a design type/);
    });
  });

  describe("setDesignReviewState", () => {
    it("walks the valid gate none → needs_board_review → approved", async () => {
      const design = await addWorkProduct({ type: "mockup", isPrimary: true });
      expect(design.reviewState).toBe("none");

      const submitted = await svc.setDesignReviewState(design.id, "needs_board_review");
      expect(submitted.reviewState).toBe("needs_board_review");

      const approved = await svc.setDesignReviewState(design.id, "approved");
      expect(approved.reviewState).toBe("approved");
    });

    it("throws on an invalid transition (none → approved)", async () => {
      const design = await addWorkProduct({ type: "design", isPrimary: true });
      await expect(svc.setDesignReviewState(design.id, "approved")).rejects.toThrow(
        /Invalid design review transition/,
      );
    });

    it("throws on an unknown review-state string", async () => {
      const design = await addWorkProduct({ type: "design", isPrimary: true });
      await expect(svc.setDesignReviewState(design.id, "bogus")).rejects.toThrow(
        /Invalid design review state/,
      );
    });

    it("throws when the work product is not a design type", async () => {
      const proof = await addWorkProduct({ type: "proof", isPrimary: false });
      await expect(svc.setDesignReviewState(proof.id, "needs_board_review")).rejects.toThrow(
        /not a design type/,
      );
    });
  });

  it("DESIGN_WORK_PRODUCT_TYPES matches the design-artifact default set", () => {
    expect([...DESIGN_WORK_PRODUCT_TYPES]).toEqual([
      "design",
      "ui_preview",
      "mockup",
      "screenshot",
      "figma_frame",
    ]);
  });
});
