import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

// WC-184 (CP0 "Grill mode"): the grill route runs ONE planner adapter turn via
// the WC-57 single-turn seam (getServerAdapter(type).execute(ctx)) and returns
// the parsed clarifying questions. We mock the adapter exactly like the WC-2
// draft test so no real LLM/CLI runs; the canned stdout is what each test asserts
// the route parses (or fails to parse) into questions.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
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
    `Skipping WC-184 draft-grill embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let plannerAgentId: string;
let issuePrefix: string;

// Make the mocked adapter emit `stdout` then return a clean result, so the
// single-turn seam (which accumulates stdout via onLog) sees the canned reply.
function mockAdapterReply(stdout: string, overrides: Record<string, unknown> = {}) {
  mockAdapterExecute.mockImplementationOnce(async (ctx: any) => {
    if (stdout.length > 0) await ctx.onLog("stdout", stdout);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      provider: "test",
      model: "test-model",
      ...overrides,
    };
  });
}

describeEmbeddedPostgres("WC-184 draft-grill planner questions", () => {
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
    server.use("/api", issueRoutes(db, {} as any));
    server.use(errorHandler);
    return server;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc184-draft-grill-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    plannerAgentId = randomUUID();
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
    runningProcesses.clear();
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      provider: "test",
      model: "test-model",
    }));
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
      role: "pm",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
  }

  it("returns parsed questions from the planner adapter reply", async () => {
    await seedCompanyAndPlanner();
    mockAdapterReply(
      JSON.stringify([
        { question: "Which identity providers?", recommendation: "Okta + Google", rationale: "Most common." },
        { question: "Self-serve onboarding?", recommendation: "Admin-only first", rationale: "Smaller surface." },
      ]),
    );

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/draft-grill`)
      .send({ prompt: "Add SSO support to the admin console." });

    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(2);
    expect(res.body.questions[0]).toEqual({
      question: "Which identity providers?",
      recommendation: "Okta + Google",
      rationale: "Most common.",
    });
    // It invoked the adapter (single-turn seam), not a heartbeat draft loop.
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    // The grill instruction (not a draft instruction) was folded into the turn.
    const ctx = mockAdapterExecute.mock.calls[0][0] as any;
    expect(String(ctx.context.workcellTaskMarkdown)).toContain("Do NOT draft an issue");
    expect(String(ctx.context.workcellTaskMarkdown)).toContain("Add SSO support to the admin console.");
  });

  it("tolerates prose + fenced JSON in the model reply", async () => {
    await seedCompanyAndPlanner();
    mockAdapterReply(
      [
        "Here are the questions I'd ask before drafting:",
        "```json",
        JSON.stringify([{ question: "MVP scope?", recommendation: "Login only", rationale: "Ship sooner." }]),
        "```",
      ].join("\n"),
    );

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/draft-grill`)
      .send({ prompt: "Add billing." });

    expect(res.status).toBe(200);
    expect(res.body.questions).toEqual([
      { question: "MVP scope?", recommendation: "Login only", rationale: "Ship sooner." },
    ]);
  });

  it("returns an empty list (no 500) when the model reply is malformed", async () => {
    await seedCompanyAndPlanner();
    mockAdapterReply("I'm not going to answer in JSON, sorry!");

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/draft-grill`)
      .send({ prompt: "Do a thing." });

    expect(res.status).toBe(200);
    expect(res.body.questions).toEqual([]);
  });

  it("returns an empty list (no 500) on an adapter-level failure", async () => {
    await seedCompanyAndPlanner();
    // A non-zero exit with otherwise-valid-looking stdout must NOT be trusted.
    mockAdapterReply(
      JSON.stringify([{ question: "ignored", recommendation: "ignored", rationale: "ignored" }]),
      { exitCode: 1, errorMessage: "model overloaded" },
    );

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/draft-grill`)
      .send({ prompt: "Add caching." });

    expect(res.status).toBe(200);
    expect(res.body.questions).toEqual([]);
  });

  it("does not create an issue (grill only asks questions)", async () => {
    await seedCompanyAndPlanner();
    mockAdapterReply(JSON.stringify([{ question: "Q?", recommendation: "R", rationale: "Why." }]));

    await request(app)
      .post(`/api/companies/${companyId}/issues/draft-grill`)
      .send({ prompt: "Add exports." });

    const issueRows = await db.select().from(issues);
    expect(issueRows).toHaveLength(0);
  });

  it("returns 409 when no planner-capable agent exists", async () => {
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
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
      .post(`/api/companies/${companyId}/issues/draft-grill`)
      .send({ prompt: "Anything." });

    expect(res.status).toBe(409);
    expect(String(res.body?.error ?? res.text)).toMatch(/no planner-capable agent/i);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
});
