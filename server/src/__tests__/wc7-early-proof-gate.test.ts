import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues, issueWorkProducts } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

// Canned adapter so any wakeup can no-op without invoking a real LLM.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "WC-7 early-proof-gate test run.",
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
    `Skipping WC-7 early-proof-gate embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-7 early proof gate at executor-submit", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;

  async function createApp() {
    const actorCompanyId = companyId;
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
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc7-early-proof-gate-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();
    app = await createApp();
  });

  afterEach(() => {
    runningProcesses.clear();
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
  }

  async function seedExecutionIssue(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Execution issue",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
    });
    return issueId;
  }

  async function seedPlanningIssue(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Planning issue",
      status: "todo",
      priority: "medium",
      workMode: "planning",
    });
    return issueId;
  }

  async function seedEvaluationIssue(): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watchdog evaluation",
      status: "todo",
      priority: "medium",
      workMode: "standard",
      originKind: "stale_active_run_evaluation",
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

  async function patchStatus(issueId: string, body: Record<string, unknown>) {
    return request(app).patch(`/api/issues/${issueId}`).send(body);
  }

  it("fails fast with 409 when an execution issue without a proof is submitted to done", async () => {
    await seedCompany();
    const issueId = await seedExecutionIssue();

    const res = await patchStatus(issueId, { status: "done" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "done requires a proof bundle",
      details: { code: "proof_required" },
    });

    // The issue is NOT mutated by this rejected PATCH — its status stays as seeded.
    const row = await db
      .select({ status: issues.status, completedAt: issues.completedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
    expect(row.status).toBe("in_progress");
    expect(row.completedAt).toBeNull();
  });

  it("allows the done request through to the regular transition once a proof bundle is attached", async () => {
    await seedCompany();
    const issueId = await seedExecutionIssue();
    await attachProof(issueId);

    const res = await patchStatus(issueId, { status: "done" });

    // The early gate passes (proof exists) → normal transition logic runs and the
    // issue actually completes (no sign-off policy attached in this test).
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.completedAt).toBeTruthy();
  });

  it("exempts planning issues from the early gate (a plan is not a proof)", async () => {
    await seedCompany();
    const issueId = await seedPlanningIssue();

    // No proof attached, but planning is exempt — the PATCH must not 409 here.
    const res = await patchStatus(issueId, { status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("exempts system-generated recovery/evaluation issues from the early gate", async () => {
    await seedCompany();
    const issueId = await seedEvaluationIssue();

    // Internal evaluation issues never carry a proof bundle by design; the gate
    // must not block their auto-completion. Mirrors the late-gate exemption.
    const res = await patchStatus(issueId, { status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("does not gate non-done PATCHes (e.g. status change to in_review)", async () => {
    await seedCompany();
    const issueId = await seedExecutionIssue();

    // The early gate must only fire when status === "done". A reviewer-facing
    // status change must be unaffected by the missing proof.
    const res = await patchStatus(issueId, { status: "in_review" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
  });
});
