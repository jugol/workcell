import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documents,
  issueWorkProducts,
  issues,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import {
  compoundFollowupService,
  parseChecklistFollowupTitles,
} from "../services/compound-followups.ts";

// ---------- Pure parser tests (no DB) ----------
describe("WC-13 parseChecklistFollowupTitles", () => {
  it("parses dash bullets inside the follow-up section", () => {
    const body = [
      "# Compound checklist",
      "",
      "## 5. Follow-up issues",
      "",
      "- First follow-up",
      "- Second follow-up",
    ].join("\n");
    expect(parseChecklistFollowupTitles(body)).toEqual(["First follow-up", "Second follow-up"]);
  });

  it("parses asterisk bullets as well", () => {
    const body = [
      "## 5. Follow-up issues",
      "",
      "* Asterisk-style bullet",
    ].join("\n");
    expect(parseChecklistFollowupTitles(body)).toEqual(["Asterisk-style bullet"]);
  });

  it("ignores bullets outside the follow-up section", () => {
    const body = [
      "# Compound checklist",
      "",
      "## 1. What changed?",
      "- Decoy bullet under wrong heading",
      "",
      "## 5. Follow-up issues",
      "",
      "- Real follow-up",
      "",
      "## 6. Next steps",
      "- Should be skipped (out of section)",
    ].join("\n");
    expect(parseChecklistFollowupTitles(body)).toEqual(["Real follow-up"]);
  });

  it("filters out the parenthesised placeholder line", () => {
    const body = [
      "## 5. Follow-up issues",
      "",
      "- (discovered debt, defects, plan gaps)",
      "- Genuine follow-up",
    ].join("\n");
    expect(parseChecklistFollowupTitles(body)).toEqual(["Genuine follow-up"]);
  });

  it("ignores bullets inside fenced code blocks", () => {
    const body = [
      "## 5. Follow-up issues",
      "",
      "```",
      "- not a real bullet",
      "```",
      "",
      "- real bullet after fence",
    ].join("\n");
    expect(parseChecklistFollowupTitles(body)).toEqual(["real bullet after fence"]);
  });

  it("returns empty list when section 5 is absent or empty", () => {
    expect(parseChecklistFollowupTitles("# Compound checklist\n\n## 1. What changed?\n- only stuff here\n")).toEqual([]);
    expect(parseChecklistFollowupTitles("")).toEqual([]);
  });
});

// ---------- DB-bound service + route tests ----------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-13 compound-followups embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-13 compound-followups service + route (D19 second slice)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let followupsSvc!: ReturnType<typeof compoundFollowupService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;

  async function createApp() {
    const actorCompanyId = companyId;
    const { vi } = await import("vitest");
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [actorCompanyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    server.use("/api", issueRoutes(db, {} as any));
    server.use(errorHandler);
    return server;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc13-compound-followups-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    followupsSvc = compoundFollowupService(db);
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
    app = await createApp();
  });

  afterEach(async () => {
    // WC-50: activity_log is append-only (WC-29 trigger rejects row DELETE),
    // so teardown must TRUNCATE rather than DELETE. TRUNCATE is DDL and
    // bypasses the row-level trigger; CASCADE collapses the FK web in one shot.
    await db.execute(
      "truncate table companies, issues, issue_documents, documents, issue_work_products, activity_log restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedParent(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
      workMode: "standard",
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

  it("service.processChecklist creates one child issue per bullet with the right shape", async () => {
    const parentId = await seedParent();
    const body = [
      "## 5. Follow-up issues",
      "",
      "- Refactor extraction",
      "- Cover edge case X",
    ].join("\n");

    const createdIds = await followupsSvc.processChecklist({
      parentIssueId: parentId,
      companyId,
      checklistBody: body,
    });
    expect(createdIds).toHaveLength(2);

    const children = await db
      .select()
      .from(issues)
      .where(and(eq(issues.parentId, parentId), eq(issues.originKind, "compound_followup")));
    expect(children).toHaveLength(2);
    const titles = children.map((row) => row.title).sort();
    expect(titles).toEqual(["Cover edge case X", "Refactor extraction"]);
    for (const child of children) {
      expect(child.status).toBe("backlog");
      expect(child.priority).toBe("medium");
      expect(child.workMode).toBe("standard");
      expect(child.companyId).toBe(companyId);
      expect(child.parentId).toBe(parentId);
      expect(child.originKind).toBe("compound_followup");
    }
  });

  it("service.processChecklist is idempotent on identical second run", async () => {
    const parentId = await seedParent();
    const body = [
      "## 5. Follow-up issues",
      "",
      "- One follow-up",
      "- Another follow-up",
    ].join("\n");

    const firstRun = await followupsSvc.processChecklist({
      parentIssueId: parentId,
      companyId,
      checklistBody: body,
    });
    expect(firstRun).toHaveLength(2);

    const secondRun = await followupsSvc.processChecklist({
      parentIssueId: parentId,
      companyId,
      checklistBody: body,
    });
    expect(secondRun).toEqual([]);

    const children = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.parentId, parentId), eq(issues.originKind, "compound_followup")));
    expect(children).toHaveLength(2);
  });

  it("service.processChecklist returns [] when body has no bullets", async () => {
    const parentId = await seedParent();
    const result = await followupsSvc.processChecklist({
      parentIssueId: parentId,
      companyId,
      checklistBody: "# Compound checklist\n\n## 5. Follow-up issues\n\n(no bullets yet)\n",
    });
    expect(result).toEqual([]);
  });

  it("route POST /issues/:id/compound-followups/process creates the children end-to-end", async () => {
    // First mark the parent done so the WC-12 auto-create produces the checklist doc.
    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent that will be completed",
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });
    await attachProof(parentId);
    await svc.update(parentId, { status: "done" });

    // Replace the auto-generated body with a filled-in body so we have real bullets.
    const filledBody = [
      "# Compound checklist",
      "",
      "## 5. Follow-up issues",
      "",
      "- Route-test follow-up A",
      "- Route-test follow-up B",
    ].join("\n");
    await db.update(documents).set({ latestBody: filledBody });

    const res = await request(app)
      .post(`/api/issues/${parentId}/compound-followups/process`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.createdIssueIds).toHaveLength(2);

    const children = await db
      .select({ title: issues.title })
      .from(issues)
      .where(and(eq(issues.parentId, parentId), eq(issues.originKind, "compound_followup")));
    const titles = children.map((c) => c.title).sort();
    expect(titles).toEqual(["Route-test follow-up A", "Route-test follow-up B"]);
  });

  it("route returns 404 when the issue has no compound-checklist document yet", async () => {
    const parentId = await seedParent();
    // No done transition, so no checklist document was auto-created.
    const res = await request(app)
      .post(`/api/issues/${parentId}/compound-followups/process`)
      .send({});
    expect(res.status).toBe(404);
  });
});
