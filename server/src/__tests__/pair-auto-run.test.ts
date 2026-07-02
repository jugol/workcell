import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pairGroupService } from "../services/pair-groups.ts";
import {
  pairRoundOrchestrator,
  type PairTurnExecutor,
} from "../services/pair-round-orchestrator.ts";
import { pairAutoRunTicker } from "../services/pair-auto-run.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping pair auto-run embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("Pair auto-run ticker (auto-run by default)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof pairGroupService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let ownerId: string;
  let counterpartId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-pair-auto-run-");
    db = createDb(tempDb.connectionString);
    svc = pairGroupService(db);
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
    ownerId = randomUUID();
    counterpartId = randomUUID();
    await db.insert(agents).values([
      { id: ownerId, companyId, name: "Owner", role: "planner", status: "idle", adapter: "claude_local" },
      { id: counterpartId, companyId, name: "CP", role: "engineer", status: "idle", adapter: "claude_local" },
    ]);
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, issues, pair_groups, pair_turns, activity_log restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Pair candidate",
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });
    return id;
  }

  it("tick advances autoRunEnabled groups by one round and leaves opted-out groups untouched", async () => {
    const autoIssue = await seedIssue();
    const manualIssue = await seedIssue();

    // Default create → autoRunEnabled=true (auto-run is the default).
    const autoGroup = await svc.create({
      companyId,
      issueId: autoIssue,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 5,
    });
    expect(autoGroup.autoRunEnabled).toBe(true);

    // Explicit opt-out → the ticker must never touch this group.
    const manualGroup = await svc.create({
      companyId,
      issueId: manualIssue,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      maxRounds: 5,
      autoRunEnabled: false,
    });
    expect(manualGroup.autoRunEnabled).toBe(false);

    const executor: PairTurnExecutor = vi.fn(async (req) => ({
      summary: `${req.role}-r${req.round}`,
      outcome: "delivered" as const,
      costCents: 10,
    }));
    const ticker = pairAutoRunTicker(db, pairRoundOrchestrator(db, executor), {
      groupsPerTick: 5,
    });

    const result = await ticker.tick();
    expect(result.errors).toEqual([]);
    expect(result.groupsRun).toBe(1); // only the auto group
    expect(executor).toHaveBeenCalledTimes(2); // one round = owner + counterpart

    const refreshedAuto = await svc.getById(companyId, autoGroup.id);
    expect(refreshedAuto?.currentRound).toBe(1);
    expect(refreshedAuto?.status).toBe("active");

    const refreshedManual = await svc.getById(companyId, manualGroup.id);
    expect(refreshedManual?.currentRound).toBe(0); // untouched
  });

  it("setAutoRun re-enables a group so the next tick picks it up", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      autoRunEnabled: false,
    });

    const executor: PairTurnExecutor = vi.fn(async (req) => ({
      summary: `${req.role}-r${req.round}`,
      outcome: "delivered" as const,
    }));
    const ticker = pairAutoRunTicker(db, pairRoundOrchestrator(db, executor));

    // Disabled → tick is a no-op for this group.
    const first = await ticker.tick();
    expect(first.groupsRun).toBe(0);
    expect(executor).not.toHaveBeenCalled();

    const enabled = await svc.setAutoRun({ companyId, id: group.id, enabled: true });
    expect(enabled?.autoRunEnabled).toBe(true);

    const second = await ticker.tick();
    expect(second.groupsRun).toBe(1);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("a failing group does not block the remaining groups in the same tick", async () => {
    const issueA = await seedIssue();
    const issueB = await seedIssue();
    const groupA = await svc.create({
      companyId,
      issueId: issueA,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
    });
    const groupB = await svc.create({
      companyId,
      issueId: issueB,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
    });

    const executor: PairTurnExecutor = vi.fn(async (req) => {
      if (req.pairGroupId === groupA.id) throw new Error("executor blew up");
      return { summary: `${req.role}-r${req.round}`, outcome: "delivered" as const };
    });
    const ticker = pairAutoRunTicker(db, pairRoundOrchestrator(db, executor), {
      groupsPerTick: 5,
    });

    const result = await ticker.tick();
    expect(result.groupsRun).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ pairGroupId: groupA.id });

    const refreshedB = await svc.getById(companyId, groupB.id);
    expect(refreshedB?.currentRound).toBe(1);
  });
});
