import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, documents, issueDocuments, issueWorkProducts, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-12 compound-checklist embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-12 compound-checklist document on Done (D19 first slice)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc12-compound-checklist-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
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
  });

  afterEach(async () => {
    // Clean up children first to satisfy FK constraints.
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(opts: { workMode?: "standard" | "planning"; originKind?: string }): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "todo",
      priority: "medium",
      workMode: opts.workMode ?? "standard",
      originKind: opts.originKind,
    });
    return issueId;
  }

  async function attachProof(issueId: string) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "proof",
      provider: "workcell",
      title: "Execution proof",
      status: "active",
    });
  }

  async function getChecklist(issueId: string) {
    return db
      .select({ key: issueDocuments.key, body: documents.latestBody, title: documents.title })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, "compound-checklist")))
      .then((rows) => rows[0] ?? null);
  }

  it("auto-creates a compound-checklist document when a non-exempt issue is marked done", async () => {
    const issueId = await seedIssue({ workMode: "standard" });
    await attachProof(issueId);

    // Before: no checklist.
    expect(await getChecklist(issueId)).toBeNull();

    const updated = await svc.update(issueId, { status: "done" });
    expect(updated?.status).toBe("done");

    const checklist = await getChecklist(issueId);
    expect(checklist).not.toBeNull();
    expect(checklist!.title).toBe("Compound checklist");
    // Body should include the canonical section headings that match the D19 spec.
    expect(checklist!.body).toContain("# Compound checklist");
    expect(checklist!.body).toContain("## 1. What changed?");
    expect(checklist!.body).toContain("## 2. Reusable learnings");
    expect(checklist!.body).toContain("## 3. Prevention rules");
    expect(checklist!.body).toContain("## 4. Failed approaches");
    expect(checklist!.body).toContain("## 5. Follow-up issues");
  });

  it("does NOT create a checklist for planning issues (workMode planning, exempt)", async () => {
    const issueId = await seedIssue({ workMode: "planning" });
    // Planning is exempt from proof gate, so no proof needed.

    const updated = await svc.update(issueId, { status: "done" });
    expect(updated?.status).toBe("done");

    expect(await getChecklist(issueId)).toBeNull();
  });

  it("does NOT create a checklist for recovery-origin (system-generated) issues", async () => {
    const issueId = await seedIssue({
      workMode: "standard",
      originKind: "stale_active_run_evaluation",
    });
    // Recovery origin is exempt from proof gate, so no proof needed.

    const updated = await svc.update(issueId, { status: "done" });
    expect(updated?.status).toBe("done");

    expect(await getChecklist(issueId)).toBeNull();
  });

  it("does NOT clobber an existing checklist on a subsequent done transition (idempotent)", async () => {
    // First completion creates the checklist.
    const issueId = await seedIssue({ workMode: "standard" });
    await attachProof(issueId);
    await svc.update(issueId, { status: "done" });

    // Simulate a human filling in the checklist after the first completion.
    const filledBody = "# Compound checklist\n\n## 5. Follow-up issues\n- Real captured follow-up.\n";
    const checklistBefore = await getChecklist(issueId);
    await db
      .update(documents)
      .set({ latestBody: filledBody })
      .where(eq(documents.latestBody, checklistBefore!.body));

    // Reopen (back to todo — in_progress would require an assignee) and re-close.
    await svc.update(issueId, { status: "todo" });
    await svc.update(issueId, { status: "done" });

    // The human content survives — the auto-create runs only when the doc is absent.
    const checklistAfter = await getChecklist(issueId);
    expect(checklistAfter!.body).toBe(filledBody);
  });
});
