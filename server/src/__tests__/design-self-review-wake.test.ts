import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

// WC-DSR (designer visual self-review): attaching a primary 시안 (HTML mockup) as
// a DESIGNER-role agent renders it to a PNG and re-wakes the designer with that
// rendered screenshot as image input (contextSnapshot.designReviewImagePaths).
// This exercises the real design-artifacts route + render service + wake fan-out
// over embedded Postgres.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-DSR design self-review wake tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// The render path needs Chromium. Skip (not fail) where unavailable.
async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const canRender = await chromiumAvailable();

const SIAN_HTML =
  '<!doctype html><html><body style="background:#0a84ff;margin:0">' +
  '<h1 style="color:#ffffff;font-size:48px;padding:40px">시안</h1>' +
  '<p style="color:#1d1d1f;font-size:16px">body copy</p></body></html>';

function htmlToDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

describeEmbeddedPostgres("designer 시안 visual self-review wake (WC-DSR)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-design-self-review-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    // Let in-flight fire-and-forget wake runs settle before truncating so a run
    // from one test does not leak into the next (mirrors design-review-routes).
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "queued"));
      if (active.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await db.execute("truncate table companies restart identity cascade" as any);
    await db.execute("truncate table activity_log restart identity cascade" as any);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId: null, source: "agent_jwt" };
  }

  // Seeds a company + designer-role agent + an unassigned issue. Unassigned so
  // the agent-mutation guard short-circuits to allowed without a checkout run.
  // The agent points at a nonexistent adapter so the queued self-review wake
  // FAILS at adapter resolution instead of spawning a real CLI — we assert the
  // run ROW (its wake context), not its terminal status.
  async function seed(role: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Designer",
      role,
      status: "active",
      adapterType: "test_nonexistent_adapter",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Design parent",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: null,
    });
    return { companyId, agentId, issueId };
  }

  (canRender ? it : it.skip)(
    "attaching a primary 시안 as a designer enqueues a self-review wake carrying designReviewImagePaths",
    async () => {
      const { companyId, agentId, issueId } = await seed("designer");

      const res = await request(createApp(agentActor(companyId, agentId)))
        .post(`/api/issues/${issueId}/design-artifacts`)
        .send({ type: "design", title: "Login 시안", url: htmlToDataUrl(SIAN_HTML), isPrimary: true });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const workProductId = res.body.id as string;

      // The render + wake is fire-and-forget — poll for the queued run.
      const run = await vi.waitFor(
        async () => {
          const rows = await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.agentId, agentId));
          expect(rows.length).toBeGreaterThan(0);
          return rows[0];
        },
        { timeout: 15_000, interval: 100 },
      );

      const ctx = run.contextSnapshot as Record<string, unknown>;
      expect(ctx.issueId).toBe(issueId);
      expect(ctx.designSelfReviewFor).toBe(workProductId);
      expect(ctx.designSelfReviewRound).toBe(1);
      expect(Array.isArray(ctx.designReviewImagePaths)).toBe(true);
      const paths = ctx.designReviewImagePaths as string[];
      expect(paths.length).toBe(1);
      expect(paths[0]).toMatch(/\.png$/);
      expect(paths[0]).toContain(workProductId);
    },
    30_000,
  );

  it("attaching a primary 시안 as a NON-designer does NOT enqueue a self-review wake", async () => {
    const { companyId, agentId, issueId } = await seed("engineer");

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/issues/${issueId}/design-artifacts`)
      .send({ type: "design", title: "Login 시안", url: htmlToDataUrl(SIAN_HTML), isPrimary: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // Give the fire-and-forget path a beat; no wake should ever be enqueued.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(rows.length).toBe(0);
  });
});
