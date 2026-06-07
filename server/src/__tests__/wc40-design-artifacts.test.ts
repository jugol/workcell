import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, issueWorkProducts, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-40 design artifacts embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-40 Open Design artifact listing route (PLAN §9 #4)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let issueId: string;

  async function createApp() {
    const actorCompanyId = companyId;
    const [{ designArtifactRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/design-artifacts.js")>(
        "../routes/design-artifacts.js",
      ),
      vi.importActual<typeof import("../middleware/index.js")>(
        "../middleware/index.js",
      ),
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
    server.use("/api", designArtifactRoutes(db));
    server.use(errorHandler);
    return server;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc40-design-artifacts-");
    db = createDb(tempDb.connectionString);
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
    app = await createApp();
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, issues, issue_work_products restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns work products matching the default design type set", async () => {
    await db.insert(issueWorkProducts).values([
      { companyId, issueId, type: "design", provider: "figma", title: "Sprint board mockup", status: "active" },
      { companyId, issueId, type: "ui_preview", provider: "workcell", title: "Dashboard preview", status: "active" },
      { companyId, issueId, type: "proof", provider: "workcell", title: "Proof", status: "active" },
    ]);
    const res = await request(app).get(`/api/companies/${companyId}/design-artifacts`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const titles = (res.body.items as any[]).map((i) => i.title).sort();
    expect(titles).toEqual(["Dashboard preview", "Sprint board mockup"]);
  });

  it("honors a ?types=... override", async () => {
    await db.insert(issueWorkProducts).values([
      { companyId, issueId, type: "screenshot", provider: "workcell", title: "S1", status: "active" },
      { companyId, issueId, type: "design", provider: "figma", title: "D1", status: "active" },
    ]);
    const res = await request(app).get(`/api/companies/${companyId}/design-artifacts?types=screenshot`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe("S1");
  });

  it("returns an empty array when the company has no matching artifacts", async () => {
    await db.insert(issueWorkProducts).values([
      { companyId, issueId, type: "proof", provider: "workcell", title: "Proof", status: "active" },
    ]);
    const res = await request(app).get(`/api/companies/${companyId}/design-artifacts`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("orders results by createdAt descending (most recent first)", async () => {
    // Insert three artifacts with explicit timestamps so the test isn't
    // dependent on insert order timing.
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-02-01T00:00:00Z");
    const t3 = new Date("2026-03-01T00:00:00Z");
    await db.insert(issueWorkProducts).values([
      { companyId, issueId, type: "design", provider: "figma", title: "old", status: "active", createdAt: t1 },
      { companyId, issueId, type: "design", provider: "figma", title: "mid", status: "active", createdAt: t2 },
      { companyId, issueId, type: "design", provider: "figma", title: "new", status: "active", createdAt: t3 },
    ]);
    const res = await request(app).get(`/api/companies/${companyId}/design-artifacts`);
    expect((res.body.items as any[]).map((i) => i.title)).toEqual(["new", "mid", "old"]);
  });

  it("WC-55: returns previewUrl (url) and body (summary) so the plugin renders real data", async () => {
    await db.insert(issueWorkProducts).values([
      {
        companyId,
        issueId,
        type: "ui_preview",
        provider: "workcell",
        title: "Dashboard v2",
        status: "active",
        url: "https://preview.example/dash-v2",
        summary: "Dashboard layout with new sidebar.",
      },
    ]);
    const res = await request(app).get(`/api/companies/${companyId}/design-artifacts`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    // Previously the route omitted these, so the plugin fell back to
    // about:blank / synthetic diff strings — the #4 overclaim.
    expect(item.previewUrl).toBe("https://preview.example/dash-v2");
    expect(item.body).toBe("Dashboard layout with new sidebar.");
  });
});
