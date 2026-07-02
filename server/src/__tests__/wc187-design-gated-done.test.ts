import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documentRevisions,
  documents,
  issueDocuments,
  issueWorkProducts,
  issues,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

// WC-187 / CP6: design-first gate. An issue whose SOURCE-OF-TRUTH design
// (isPrimary design-type work product) is NOT board-approved must not be allowed
// to complete development / reach Done — mirroring the WC-3 proof gate. This
// harness mirrors wc3-proof-gated-done.test.ts (embedded Postgres, real
// issueService.update). To prove the DESIGN gate (not the proof gate) is the
// thing that blocks, every issue here also carries a proof bundle, so the proof
// gate (which runs first) always passes; only the design gate can reject.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-187 design-gated-done embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regenerated per test (beforeEach) so the shared embedded-Postgres DB stays
// collision-free and order-independent. Each assertion creates its own issue.
let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-187 design-gated Done", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc187-design-gated-done-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    // issue_prefix is UNIQUE across companies — derive a per-test value.
    issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      // WC-195: this suite exercises the design-first gate, so the company opts in.
      requireDesignFirst: true,
    });
  });

  afterEach(async () => {
    // Per-test unique ids isolate data; clean up children before parents.
    // The WC-12 compound-checklist document is auto-created on Done, so tear down
    // issue_documents + documents + document_revisions before issues + companies.
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(status: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Design-gated issue",
      status,
      priority: "medium",
    });
    return issueId;
  }

  // Satisfy the WC-3 proof gate (which runs BEFORE the design gate) so that any
  // rejection observed here is attributable to the design gate, not the proof gate.
  async function attachProof(issueId: string) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "proof",
      provider: "workcell",
      title: "proof",
      status: "active",
    });
  }

  async function attachAuthoritativeDesign(issueId: string, reviewState: string) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "design",
      provider: "workcell",
      title: "Source-of-truth design",
      url: "https://figma.com/file/cp6",
      status: "active",
      isPrimary: true,
      reviewState,
    });
  }

  it("rejects the done transition when the authoritative design is needs_board_review", async () => {
    const issueId = await seedIssue("todo");
    await attachProof(issueId);
    await attachAuthoritativeDesign(issueId, "needs_board_review");

    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
      message:
        "An approved source-of-truth design is required before completing this issue " +
        "(create + board-approve a design, or mark the issue design-exempt).",
      details: { code: "design_review_pending", issueId },
    });

    // The issue stays un-completed because the guard threw before persisting.
    const row = await db
      .select({ status: issues.status, completedAt: issues.completedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(row.status).toBe("todo");
    expect(row.completedAt).toBeNull();
  });

  it("rejects the done transition when the authoritative design is changes_requested", async () => {
    const issueId = await seedIssue("todo");
    await attachProof(issueId);
    await attachAuthoritativeDesign(issueId, "changes_requested");

    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
      message:
        "An approved source-of-truth design is required before completing this issue " +
        "(create + board-approve a design, or mark the issue design-exempt).",
      details: { code: "design_review_pending", issueId },
    });

    const row = await db
      .select({ status: issues.status, completedAt: issues.completedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(row.status).toBe("todo");
    expect(row.completedAt).toBeNull();
  });

  it("allows the done transition when the authoritative design is approved", async () => {
    const issueId = await seedIssue("todo");
    await attachProof(issueId);
    await attachAuthoritativeDesign(issueId, "approved");

    const updated = await svc.update(issueId, { status: "done" });
    expect(updated?.status).toBe("done");
    expect(updated?.completedAt).toBeInstanceOf(Date);

    const row = await db
      .select({ status: issues.status, completedAt: issues.completedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(row.status).toBe("done");
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  // WC-195: design is REQUIRED by default — an issue with no approved
  // source-of-truth design cannot reach Done unless it is design-exempt.
  it("blocks done when design is required (default) and no design exists", async () => {
    const issueId = await seedIssue("todo");
    await attachProof(issueId);

    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
      details: { code: "design_review_pending", issueId },
    });

    const row = await db
      .select({ status: issues.status, completedAt: issues.completedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(row.status).toBe("todo");
    expect(row.completedAt).toBeNull();
  });

  it("blocks done when required and only non-authoritative designs exist", async () => {
    // Non-primary designs do not form an authoritative source-of-truth design, so
    // under the required default there is still no approved design → blocked.
    const issueId = await seedIssue("todo");
    await attachProof(issueId);
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "design",
      provider: "workcell",
      title: "Variant A (not source of truth)",
      status: "active",
      isPrimary: false,
      reviewState: "needs_board_review",
    });

    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
      details: { code: "design_review_pending", issueId },
    });
  });

  it("blocks done when required and only a primary proof exists (a proof is not a design)", async () => {
    // A primary proof is isPrimary but not a design type → no authoritative design
    // → under the required default, still blocked. Guards against the gate keying
    // off isPrimary alone.
    const issueId = await seedIssue("todo");
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "proof",
      provider: "workcell",
      title: "primary proof",
      status: "active",
      isPrimary: true,
      reviewState: "needs_board_review",
    });

    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
      details: { code: "design_review_pending", issueId },
    });
  });

  // WC-195: the opt-out — a design-exempt issue (e.g. obvious backend-only work)
  // reaches Done with no design, exactly like before the gate existed.
  it("allows done when the issue is design-exempt and has no design", async () => {
    const issueId = await seedIssue("todo");
    await attachProof(issueId);
    await db
      .update(issues)
      .set({ designRequirement: { required: false, reason: "backend-only", setByKind: "manual" } })
      .where(eq(issues.id, issueId));

    const updated = await svc.update(issueId, { status: "done" });
    expect(updated?.status).toBe("done");
    expect(updated?.completedAt).toBeInstanceOf(Date);

    const row = await db
      .select({ status: issues.status, completedAt: issues.completedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(row.status).toBe("done");
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  // WC-199: a planning-mode issue is inherently non-screen, so it shares the proof
  // gate's exemption — it reaches Done with no design even when the company requires
  // design-first. Regression: the design gate previously checked only
  // bypassProofRequirement and wrongly blocked planning/recovery issues.
  it("allows done for a planning-mode issue with no design (planning is non-screen)", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Planning issue",
      status: "todo",
      priority: "medium",
      workMode: "planning",
    });
    const updated = await svc.update(issueId, { status: "done" });
    expect(updated?.status).toBe("done");
    expect(updated?.completedAt).toBeInstanceOf(Date);
  });
});
