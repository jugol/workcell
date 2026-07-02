import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, costEvents, createDb, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { costService } from "../services/costs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-11 issue-list cost embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let agentId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-11 issue list carries totalCostCents for each row", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let costs!: ReturnType<typeof costService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc11-issue-list-cost-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    costs = costService(db);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      permissions: {},
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(title: string): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "todo",
      priority: "medium",
    });
    return issueId;
  }

  async function recordCost(issueId: string, cents: number) {
    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId,
      provider: "test",
      model: "test-model",
      costCents: cents,
      occurredAt: new Date(),
    });
  }

  it("sumCostCentsByIssueIds returns a per-issue total for the requested subset", async () => {
    const aId = await seedIssue("Issue A");
    const bId = await seedIssue("Issue B");
    const cId = await seedIssue("Issue C (no cost)");

    // Two events on A summing to 4287¢, one event on B.
    await recordCost(aId, 1000);
    await recordCost(aId, 3287);
    await recordCost(bId, 750);

    const map = await costs.sumCostCentsByIssueIds(companyId, [aId, bId, cId]);

    expect(map.get(aId)).toBe(4287);
    expect(map.get(bId)).toBe(750);
    // Issues without any cost events are simply absent from the Map — the
    // list endpoint's `?? 0` fallback turns that into `totalCostCents: 0`.
    expect(map.has(cId)).toBe(false);
  });

  it("returns an empty Map for an empty input (short-circuits the query)", async () => {
    const result = await costs.sumCostCentsByIssueIds(companyId, []);
    expect(result.size).toBe(0);
  });

  it("issueService.list populates totalCostCents on every returned row", async () => {
    const billedId = await seedIssue("Billed issue");
    const freeId = await seedIssue("Free issue");

    await recordCost(billedId, 5000); // $50.00

    const rows = await svc.list(companyId);
    const billed = rows.find((row) => row.id === billedId);
    const free = rows.find((row) => row.id === freeId);

    expect(billed?.totalCostCents).toBe(5000);
    // The list endpoint uses `?? 0` so absent-from-Map becomes an explicit 0
    // (not undefined) — the UI can rely on the field being present on list
    // responses and distinguish "verified no cost" from "field not carried".
    expect(free?.totalCostCents).toBe(0);
  });
});
