import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, documentRevisions, documents, issueDocuments, issueWorkProducts, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-3 proof-gated-done embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regenerated per test (beforeEach) so the shared embedded-Postgres DB stays
// collision-free and order-independent. Each assertion creates its own issue.
let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-3 proof-gated Done", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc3-proof-gated-done-");
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
    });
  });

  afterEach(async () => {
    // Per-test unique ids isolate data; clean up children before parents.
    // WC-12 introduced an auto-created compound-checklist document on Done,
    // so we now also tear down issue_documents + documents + document_revisions
    // (children) before issues + companies (parents).
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
      title: "Proof-gated issue",
      status,
      priority: "medium",
    });
    return issueId;
  }

  it("rejects the done transition when the issue has no proof bundle", async () => {
    const issueId = await seedIssue("todo");

    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
      message: "done requires a proof bundle",
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

  it("allows the done transition and stamps completedAt once a proof bundle exists", async () => {
    const issueId = await seedIssue("todo");

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "proof",
      provider: "workcell",
      title: "proof",
      status: "active",
    });

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

  it("does not gate a non-proof work product type (proof existence is type-specific)", async () => {
    const issueId = await seedIssue("todo");

    // A non-proof work product must NOT satisfy the gate.
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "document",
      provider: "workcell",
      title: "not a proof",
      status: "active",
    });

    await expect(svc.update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 409,
      message: "done requires a proof bundle",
    });
  });

  it("exempts system-generated recovery/evaluation issues from the proof gate", async () => {
    // The platform auto-completes internal bookkeeping issues (e.g. watchdog
    // false-positive folds); these produce no deliverable work and never carry a
    // proof bundle, so the gate must not block them.
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watchdog evaluation",
      status: "todo",
      priority: "medium",
      originKind: "stale_active_run_evaluation",
    });

    const updated = await svc.update(issueId, { status: "done" });
    expect(updated?.status).toBe("done");
    expect(updated?.completedAt).toBeInstanceOf(Date);
  });

  it("exempts planning issues from the proof gate (a plan is not a proof)", async () => {
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
