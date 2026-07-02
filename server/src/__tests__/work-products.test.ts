import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, issueWorkProducts, issues } from "@workcell/db";
import type { IssueWorkProduct } from "@workcell/shared";
import {
  DESIGN_REVIEW_STATES,
  DESIGN_WORK_PRODUCT_TYPES,
  deriveIssueDesignGate,
  isLikelyUiWork,
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
    screenKey: null,
    screenName: null,
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
    // WC-200: the approved design is framed as the implementation target — QA
    // verifies against it, and surrounding UI follows the project design system.
    expect(gate.directive).toContain("implementation target");
    expect(gate.directive).toContain("QA verifies the result against this design");
    expect(gate.directive).toContain("project's design system");
    expect(gate.directive).not.toContain("HOLD");
  });

  it("does NOT inline a data:text/html 시안 url into the directive (prompt-blowup guard)", () => {
    // design_attach stores the 시안 as a data:text/html URL holding the whole
    // mockup (hundreds of KB). Inlining it blew the task prompt past the model
    // context window (419KB prompt → codex/claude 'ran out of room' loop).
    const hugeDataUrl = "data:text/html;charset=utf-8," + "%20".repeat(200_000);
    const gate = deriveIssueDesignGate([
      makeWorkProduct({
        title: "Onboarding screen",
        url: hugeDataUrl,
        isPrimary: true,
        reviewState: "approved",
      }),
    ]);
    expect(gate.approved).toBe(true);
    expect(gate.directive).toContain('"Onboarding screen"');
    expect(gate.directive).toContain("Build and verify against it");
    // The directive stays small: the data: URL is omitted, not inlined.
    expect(gate.directive).not.toContain("data:text/html");
    expect(gate.directive.length).toBeLessThan(2_000);
    // authoritativeDesign still carries the real url for UI preview / API use.
    expect(gate.authoritativeDesign?.url).toBe(hugeDataUrl);
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

  it("designs present (two distinct screens) but none designated primary → no hold, informative directive", () => {
    const gate = deriveIssueDesignGate([
      makeWorkProduct({ id: "d1", isPrimary: false, reviewState: "none", title: "Variant A" }),
      makeWorkProduct({ id: "d2", isPrimary: false, reviewState: "none", title: "Variant B" }),
    ]);
    expect(gate.hasDesign).toBe(true);
    // Two distinct titles → two screens; neither is an explicit primary.
    expect(gate.screens).toHaveLength(2);
    expect(gate.authoritativeDesign).toBeNull();
    expect(gate.approved).toBe(false);
    // Optional issue, no explicitly-primary unapproved screen → does NOT hold.
    expect(gate.developmentHold).toBe(false);
    expect(gate.directive).toContain("not all board-approved");
  });

  it("multi-screen: holds until EVERY screen is approved, then builds against all (R3)", () => {
    const partly = deriveIssueDesignGate(
      [
        makeWorkProduct({ id: "s1", screenKey: "login", screenName: "로그인", isPrimary: true, reviewState: "approved" }),
        makeWorkProduct({ id: "s2", screenKey: "home", screenName: "홈", isPrimary: true, reviewState: "needs_board_review" }),
      ],
      { designRequired: true },
    );
    expect(partly.screens).toHaveLength(2);
    expect(partly.approved).toBe(false); // not ALL approved
    expect(partly.developmentHold).toBe(true);
    expect(partly.directive).toContain("홈");

    const allApproved = deriveIssueDesignGate(
      [
        makeWorkProduct({ id: "s1", screenKey: "login", screenName: "로그인", isPrimary: true, reviewState: "approved" }),
        makeWorkProduct({ id: "s2", screenKey: "home", screenName: "홈", isPrimary: true, reviewState: "approved" }),
      ],
      { designRequired: true },
    );
    expect(allApproved.approved).toBe(true);
    expect(allApproved.developmentHold).toBe(false);
    expect(allApproved.directive).toContain("로그인");
    expect(allApproved.directive).toContain("홈");
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

  // WC-195/WC-200: design required + no design at all → HOLD, and the directive
  // points the designer at the project design system as the source of design truth.
  it("design required with no designs → hold directive that anchors on the project design system", () => {
    const gate = deriveIssueDesignGate([], { designRequired: true });
    expect(gate.hasDesign).toBe(false);
    expect(gate.developmentHold).toBe(true);
    expect(gate.directive).toContain("HOLD development");
    expect(gate.directive).toContain("design-requirement");
    // The directive anchors the new 시안 on the project's existing design system
    // (tokens + approved designs) rather than inventing a parallel one.
    expect(gate.directive).toContain("design-system tokens");
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
    it("makes a design product authoritative and SUPERSEDES (deletes) a prior non-approved authoritative design", async () => {
      const first = await addWorkProduct({ type: "design", isPrimary: true }); // reviewState "none"
      const second = await addWorkProduct({ type: "design", isPrimary: false });

      const updated = await svc.setAuthoritativeDesign(second.id);
      expect(updated.id).toBe(second.id);
      expect(updated.isPrimary).toBe(true);

      // WC-202: the prior non-approved primary is superseded → hard-deleted (not
      // merely demoted), so versions don't pile up.
      expect(await svc.getById(first.id)).toBeNull();

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

    it("screen-scoped sweep: deletes the SAME screen's superseded versions, KEEPS a different screen on the same issue (R5), and never touches a different issue", async () => {
      // Screen "login": an older version + the about-to-be-approved current.
      const loginOld = await addWorkProduct({ type: "mockup", title: "Login 시안", screenKey: "login", isPrimary: false });
      const loginNew = await addWorkProduct({ type: "mockup", title: "Login 시안 v2", screenKey: "login", isPrimary: true });
      // A DIFFERENT screen on the SAME issue must COEXIST (one issue → many screens).
      const dashboard = await addWorkProduct({ type: "design", title: "Dashboard 시안", screenKey: "dashboard", isPrimary: true, reviewState: "needs_board_review" });
      // A different issue's design must SURVIVE.
      const otherIssueId = randomUUID();
      await db.insert(issues).values({ id: otherIssueId, companyId, title: "Other", status: "in_progress", priority: "medium", workMode: "standard" });
      const otherScreen = await addWorkProduct({ type: "mockup", title: "Login 시안", screenKey: "login", isPrimary: true, issueId: otherIssueId });

      await svc.setDesignReviewState(loginNew.id, "needs_board_review");
      await svc.setDesignReviewState(loginNew.id, "approved");

      expect(await svc.getById(loginOld.id)).toBeNull(); // same screen, superseded → deleted
      expect((await svc.getById(loginNew.id))?.id).toBe(loginNew.id); // keeper stays
      expect((await svc.getById(dashboard.id))?.id).toBe(dashboard.id); // DIFFERENT screen, same issue → coexists
      expect((await svc.getById(otherScreen.id))?.id).toBe(otherScreen.id); // different issue untouched
    });

    it("screen-scoped sweep: removes the same screen's other-type drafts, but a DIFFERENT screen's approved-primary survives", async () => {
      // Screen "home": a draft screenshot + a 'none' draft design + the keeper mockup.
      const homeDraftShot = await addWorkProduct({ type: "screenshot", title: "Home", screenKey: "home", isPrimary: false, reviewState: "none" });
      const homeNoneDraft = await addWorkProduct({ type: "design", title: "Home", screenKey: "home", isPrimary: false, reviewState: "none" });
      const homeKeeper = await addWorkProduct({ type: "mockup", title: "Home", screenKey: "home", isPrimary: true });
      // A DIFFERENT screen's approved-primary (even on the same issue) survives.
      const settingsPreview = await addWorkProduct({ type: "ui_preview", title: "Settings", screenKey: "settings", isPrimary: true, reviewState: "approved" });

      await svc.setDesignReviewState(homeKeeper.id, "needs_board_review");
      await svc.setDesignReviewState(homeKeeper.id, "approved");

      expect(await svc.getById(homeDraftShot.id)).toBeNull(); // same screen draft → deleted
      expect(await svc.getById(homeNoneDraft.id)).toBeNull(); // same screen 'none' → deleted
      expect((await svc.getById(settingsPreview.id))?.id).toBe(settingsPreview.id); // DIFFERENT screen survives
      expect((await svc.getById(homeKeeper.id))?.id).toBe(homeKeeper.id); // keeper stays
    });

    it("promoting a new primary (setAuthoritativeDesign) sweeps the SAME screen's superseded versions", async () => {
      const old = await addWorkProduct({ type: "design", title: "Profile v1", screenKey: "profile", isPrimary: false, reviewState: "needs_board_review" });
      const fresh = await addWorkProduct({ type: "design", title: "Profile v2", screenKey: "profile", isPrimary: false, reviewState: "needs_board_review" });

      await svc.setAuthoritativeDesign(fresh.id);

      expect(await svc.getById(old.id)).toBeNull(); // superseded same screen → deleted on promote
      expect((await svc.getById(fresh.id))?.isPrimary).toBe(true); // promoted keeper stays
    });

    it("getCurrentScreensForIssue groups an issue's designs into one entry per screen (R5)", async () => {
      await addWorkProduct({ type: "mockup", title: "Login 시안", screenKey: "login", screenName: "로그인", isPrimary: false, reviewState: "approved" });
      await addWorkProduct({ type: "mockup", title: "Login 시안 v2", screenKey: "login", screenName: "로그인", isPrimary: true, reviewState: "approved" });
      await addWorkProduct({ type: "design", title: "Home 시안", screenKey: "home", screenName: "홈", isPrimary: true, reviewState: "needs_board_review" });

      const screens = await svc.getCurrentScreensForIssue(issueId, companyId);
      expect(screens).toHaveLength(2); // login + home
      const login = screens.find((s) => s.screenKey === "login");
      expect(login?.versions).toHaveLength(2); // both login versions grouped
      expect(login?.current.isPrimary).toBe(true); // current = the primary one
      expect(login?.approved).toBe(true);
      const home = screens.find((s) => s.screenKey === "home");
      expect(home?.approved).toBe(false);
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

describe("isLikelyUiWork (WC-201 — design-first applies to UI work only)", () => {
  it("is TRUE for clear UI/screen work (KR + EN, title or description, case-insensitive)", () => {
    expect(isLikelyUiWork({ title: "로그인 화면 만들기" })).toBe(true);
    expect(isLikelyUiWork({ title: "Add a settings page" })).toBe(true);
    expect(isLikelyUiWork({ title: "button 컴포넌트 추가" })).toBe(true);
    expect(isLikelyUiWork({ title: "시안 반영" })).toBe(true);
    expect(isLikelyUiWork({ title: "Build the DASHBOARD" })).toBe(true); // case-insensitive
    expect(isLikelyUiWork({ title: "Fix checkout page layout" })).toBe(true);
    expect(isLikelyUiWork({ title: "Unblock the login screen layout" })).toBe(true);
    // description-only match
    expect(isLikelyUiWork({ title: "Task 4", description: "tweak the modal css" })).toBe(true);
    // labels-only match (optional param)
    expect(isLikelyUiWork({ title: "x", labels: ["frontend"] })).toBe(true);
  });

  it("is FALSE for non-UI build/infra work (the trigger case)", () => {
    expect(isLikelyUiWork({ title: "make it runnable in an emulator" })).toBe(false);
    expect(isLikelyUiWork({ title: "에뮬레이터에서 실행되게 빌드 설정" })).toBe(false);
    expect(isLikelyUiWork({ title: "fix backend build script" })).toBe(false);
    expect(isLikelyUiWork({ title: "deploy infra" })).toBe(false); // labels omitted
    expect(isLikelyUiWork({ title: "Refactor the database migration runner" })).toBe(false);
  });

  it("is FALSE for operational unblock/checkout/run-lock cleanup even with incidental design words", () => {
    expect(
      isLikelyUiWork({
        title: "운영 차단 해소: LOR-713 stale checkout 정리",
        description:
          "LOR-713 시안 작업을 풀기 위한 운영 정리 이슈입니다. stale checkout/run-lock ownership conflict만 해소합니다.",
      }),
    ).toBe(false);
    expect(
      isLikelyUiWork({
        title: "Infra unblock: clear run-lock for design request",
        description: "Do not create a mockup; fix the run ownership conflict.",
      }),
    ).toBe(false);
  });

  it("is FALSE for platform design-gate logic regressions but still TRUE for actual screen implementation", () => {
    expect(
      isLikelyUiWork({
        title: "회귀 수정: 승인된 동일 screenKey 시안을 새 구현 이슈 design gate로 자동 승계",
        description:
          "비화면 서버/gate 로직 수정입니다. duplicate design-request recursion을 막고 approval/design gate projection을 고칩니다.",
      }),
    ).toBe(false);
    expect(
      isLikelyUiWork({
        title: "Design 시안: 구현: 한국어 튜토리얼 시작 커리큘럼을 왕초보 순서로 변경",
        description: "screenKey: `tutorial-start-curriculum`",
      }),
    ).toBe(true);
    expect(
      isLikelyUiWork({
        title: "구현: 한국어 튜토리얼 시작 커리큘럼 화면 변경",
        description: "screenKey: `tutorial-start-curriculum`",
      }),
    ).toBe(true);
  });
});
