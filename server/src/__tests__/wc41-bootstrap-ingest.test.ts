import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-41 bootstrap ingest embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-41 bootstrap-from-spec ingest route (PLAN §9 #1)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;

  async function createApp(actorOverride?: Record<string, unknown>) {
    const actorCompanyId = companyId;
    const [{ bootstrapRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/bootstrap.js")>("../routes/bootstrap.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = actorOverride ?? {
        type: "board",
        userId: "local-board",
        companyIds: [actorCompanyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    server.use("/api", bootstrapRoutes(db));
    server.use(errorHandler);
    return server;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc41-bootstrap-");
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
    app = await createApp();
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, projects, issues, activity_log restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a project + initial issues from a spec payload", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/bootstrap/ingest`)
      .send({
        project: {
          name: "Imported repo",
          description: "Bootstrapped from existing-repo scan",
        },
        issues: [
          { title: "Add CI pipeline", priority: "high" },
          { title: "Document setup steps", description: "Cover dev env + CI." },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.project.name).toBe("Imported repo");
    expect(res.body.issues).toHaveLength(2);

    const issueRows = await db
      .select({ title: issues.title, priority: issues.priority, status: issues.status, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(issueRows).toHaveLength(2);
    const titles = issueRows.map((r) => r.title).sort();
    expect(titles).toEqual(["Add CI pipeline", "Document setup steps"]);
    // All issues are seeded as backlog by default.
    expect(issueRows.every((r) => r.status === "backlog")).toBe(true);
    // The high-priority issue keeps its priority; the other defaults to medium.
    const byTitle = new Map(issueRows.map((r) => [r.title, r]));
    expect(byTitle.get("Add CI pipeline")?.priority).toBe("high");
    expect(byTitle.get("Document setup steps")?.priority).toBe("medium");
  });

  it("returns 400 when project.name is missing", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/bootstrap/ingest`)
      .send({ project: { description: "no name" } });
    expect(res.status).toBe(400);
  });

  it("silently skips malformed issue entries but creates the rest", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/bootstrap/ingest`)
      .send({
        project: { name: "Mixed payload" },
        issues: [
          { title: "Good issue" },
          { description: "no title" },
          { title: "" },
          null,
          { title: "Another good one" },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.issues).toHaveLength(2);
    expect((res.body.issues as any[]).map((i) => i.title).sort()).toEqual([
      "Another good one",
      "Good issue",
    ]);
  });

  it("creates the project even when no issues are provided", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/bootstrap/ingest`)
      .send({ project: { name: "Greenfield" } });
    expect(res.status).toBe(201);
    expect(res.body.project.name).toBe("Greenfield");
    expect(res.body.issues).toEqual([]);
  });

  it("uses 'medium' as the priority default when value is not in the allowed set", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/bootstrap/ingest`)
      .send({
        project: { name: "Strict priority" },
        issues: [{ title: "Issue", priority: "URGENT" }],
      });
    expect(res.status).toBe(201);
    expect(res.body.issues[0].priority).toBe("medium");
  });

  // WC-212 (production-readiness Wave 1, fix #4): bound the payload and gate on
  // board access so a member/agent cannot mint unbounded projects+issues.
  it("returns 400 when issues[] exceeds the cap (and creates nothing)", async () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => ({ title: `Issue ${i}` }));
    const res = await request(app)
      .post(`/api/companies/${companyId}/bootstrap/ingest`)
      .send({ project: { name: "Over cap" }, issues: tooMany });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/too many issues/i);

    // The over-cap request must be rejected wholesale — no project/issues created.
    const projectRows = await db.execute(
      `select count(*)::int as count from projects where company_id = '${companyId}'` as any,
    );
    expect((projectRows as any)[0]?.count ?? 0).toBe(0);
    const issueRows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(issueRows).toHaveLength(0);
  });

  it("accepts exactly the cap (200 issues)", async () => {
    const atCap = Array.from({ length: 200 }, (_, i) => ({ title: `Issue ${i}` }));
    const res = await request(app)
      .post(`/api/companies/${companyId}/bootstrap/ingest`)
      .send({ project: { name: "At cap" }, issues: atCap });
    expect(res.status).toBe(201);
    expect(res.body.issues).toHaveLength(200);
  });

  it("returns 403 for a non-board actor (agent key)", async () => {
    const agentApp = await createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId,
      source: "agent_key",
    });
    const res = await request(agentApp)
      .post(`/api/companies/${companyId}/bootstrap/ingest`)
      .send({ project: { name: "Agent attempt" }, issues: [{ title: "x" }] });
    expect(res.status).toBe(403);
  });
});
