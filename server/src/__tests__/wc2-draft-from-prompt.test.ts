import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueDocuments,
  issues,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

// Canned adapter so the assignment wakeup can queue/run without invoking a real LLM.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "WC-2 planner draft test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-2 draft-from-prompt embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regenerated per test (beforeEach) so the shared embedded-Postgres DB stays
// collision-free and order-independent without a cross-test TRUNCATE race.
let companyId: string;
let plannerAgentId: string;
let issuePrefix: string;

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("WC-2 draft-from-prompt planner loop", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;

  async function createApp(actor: Record<string, unknown>) {
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    // Minimal storage stub: the draft route never touches storage.
    server.use("/api", issueRoutes(db, {} as any));
    server.use(errorHandler);
    return server;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc2-draft-from-prompt-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    plannerAgentId = randomUUID();
    // issue_prefix is also UNIQUE across companies — derive a per-test value.
    issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();
    app = await createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
  });

  afterEach(() => {
    // Per-test unique ids isolate data; just stop run tracking and reset the mock.
    runningProcesses.clear();
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndPlanner() {
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: plannerAgentId,
      companyId,
      name: "Planner",
      // "planner" is not a built-in role; "pm" is the planner-capable role used here.
      role: "pm",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
  }

  it("creates a planning draft assigned to the planner and fires the assignment wakeup", async () => {
    await seedCompanyAndPlanner();

    const prompt = "Add a CSV export button to the reports page so users can download their data.";
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/draft-from-prompt`)
      .send({ prompt });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: "todo",
        workMode: "planning",
        originKind: "planner_draft_request",
        assigneeAgentId: plannerAgentId,
      }),
    );
    // The drafting instruction is embedded in the description and tells the agent
    // exactly how to write the structured result back.
    expect(res.body.description).toContain("issue-draft");
    expect(res.body.description).toContain("## Acceptance Criteria");
    expect(res.body.description).toContain("## Non-Goals");
    expect(res.body.description).toContain("## Proof Surface");
    expect(res.body.description).toContain("## Suggested Owner Role");
    expect(res.body.description).toContain(prompt);
    // Title is derived from the prompt.
    expect(typeof res.body.title).toBe("string");
    expect(res.body.title.length).toBeGreaterThan(0);

    const issueId = res.body.id as string;

    // The row is persisted with the WC-2 origin marker and planning mode. Status is
    // asserted on the create response above (todo, not backlog) — once the assignment
    // wakeup fires, the claimed run may transition the row to in_progress, so we accept
    // either here rather than racing the scheduler.
    const persisted = await db
      .select({
        status: issues.status,
        workMode: issues.workMode,
        originKind: issues.originKind,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(persisted).toEqual({
      status: expect.stringMatching(/^(todo|in_progress)$/),
      workMode: "planning",
      originKind: "planner_draft_request",
      assigneeAgentId: plannerAgentId,
    });

    // The assignment wakeup fires the planner's run (queued/running/succeeded), proving
    // we reuse the existing heartbeat/run machinery rather than a parallel system.
    const wokeRun = await waitForCondition(async () => {
      const run = await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`)
        .then((rows) => rows[0] ?? null);
      return Boolean(run && run.agentId === plannerAgentId);
    });
    expect(wokeRun).toBe(true);
  });

  // WC-211 (finding 2 — UX): a long prompt must yield a CLEAN, short title (not
  // the raw full-paragraph prompt) while the FULL prompt still drives the planner
  // instruction in the description.
  it("(finding 2) derives a short clean title from a long prompt; full prompt still drives the instruction", async () => {
    await seedCompanyAndPlanner();

    const longPrompt =
      "Build a comprehensive analytics dashboard that aggregates user engagement " +
      "metrics across every product surface, supports custom date ranges, exports " +
      "to CSV and PDF, and refreshes in near real time with websocket updates.";

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/draft-from-prompt`)
      .send({ prompt: longPrompt });

    expect(res.status).toBe(201);
    const title = res.body.title as string;

    // Short title: capped (~70 + the "…"), truncated, no trailing partial word.
    expect(title.length).toBeLessThanOrEqual(71);
    expect(title.endsWith("…")).toBe(true);
    // It is a clean PREFIX of the prompt (word boundary), not a mid-word cut.
    const withoutEllipsis = title.slice(0, -1).trimEnd();
    expect(longPrompt.startsWith(withoutEllipsis)).toBe(true);
    // The char immediately after the kept prefix is a space in the source prompt
    // (proves we broke on a word boundary, not mid-word).
    expect(longPrompt[withoutEllipsis.length]).toBe(" ");

    // The FULL prompt is preserved in the description so the planner sees it all.
    expect(res.body.description).toContain(longPrompt);
    expect(res.body.description).toContain("## Acceptance Criteria");
  });

  it("persists the agent's structured write-back to the issue-draft document", async () => {
    await seedCompanyAndPlanner();

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/draft-from-prompt`)
      .send({ prompt: "Draft a plan to add rate limiting to the public API." });
    expect(res.status).toBe(201);
    const issueId = res.body.id as string;

    // Simulate what the planner agent does mid-run: PUT the structured markdown to the
    // issue-draft document via the existing document route, acting as the agent.
    const agentApp = await createApp({
      type: "agent",
      agentId: plannerAgentId,
      companyId,
      runId: null,
    });
    const draftBody = [
      "## Acceptance Criteria",
      "- Requests over the limit return HTTP 429.",
      "",
      "## Non-Goals",
      "- Per-user billing tiers.",
      "",
      "## Proof Surface",
      "- Integration test asserting 429 after the threshold.",
      "",
      "## Suggested Owner Role",
      "- engineer",
    ].join("\n");

    const docRes = await request(agentApp)
      .put(`/api/issues/${issueId}/documents/issue-draft`)
      .send({ format: "markdown", body: draftBody, title: "Issue Draft" });
    expect([200, 201]).toContain(docRes.status);

    // The issue_documents row with key "issue-draft" exists after the write-back, and it
    // is a normal (non-system) key so it is discoverable via listDocuments.
    const docRow = await db
      .select({
        key: issueDocuments.key,
        latestBody: documents.latestBody,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, "issue-draft")))
      .then((rows) => rows[0] ?? null);
    expect(docRow).not.toBeNull();
    expect(docRow!.key).toBe("issue-draft");
    expect(docRow!.latestBody).toContain("## Acceptance Criteria");
    expect(docRow!.latestBody).toContain("## Suggested Owner Role");
  });

  it("returns 409 when no planner-capable agent exists", async () => {
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    // An engineer-only company has no planner/pm/ceo agent, and more than one active
    // agent would also be ambiguous — here a single non-planner role still resolves via
    // the "exactly one active agent" fallback, so add two to force the 409 path.
    await db.insert(agents).values([
      {
        id: randomUUID(),
        companyId,
        name: "Eng A",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: randomUUID(),
        companyId,
        name: "Eng B",
        role: "designer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/draft-from-prompt`)
      .send({ prompt: "Anything." });
    expect(res.status).toBe(409);
    expect(String(res.body?.error ?? res.text)).toMatch(/no planner-capable agent/i);
  });
});
