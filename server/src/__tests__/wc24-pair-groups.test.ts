import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, pairGroups, pairTurns } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pairGroupService } from "../services/pair-groups.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-24 pair-groups embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-24 PairGroup data model + service (P2 §3 second slice)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof pairGroupService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc24-pair-groups-");
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
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, issues, pair_groups, pair_turns restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(role: string, name = role): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role,
      status: "idle",
      adapter: "claude_local",
    });
    return id;
  }

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

  it("create() inserts a pair_groups row and flips the issue to workOwnerKind=pair", async () => {
    const ownerId = await seedAgent("planner");
    const counterpartId = await seedAgent("engineer");
    const issueId = await seedIssue();

    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
    });
    expect(group.id).toBeTruthy();
    expect(group.companyId).toBe(companyId);
    expect(group.issueId).toBe(issueId);
    expect(group.ownerAgentId).toBe(ownerId);
    expect(group.counterpartAgentId).toBe(counterpartId);
    expect(group.status).toBe("active");
    expect(group.currentRound).toBe(0);
    expect(group.maxRounds).toBe(10);

    // The parent issue is updated atomically — workOwnerKind=pair and the
    // pairGroupId back-reference is set.
    const updatedIssue = await db
      .select({ workOwnerKind: issues.workOwnerKind, pairGroupId: issues.pairGroupId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(updatedIssue.workOwnerKind).toBe("pair");
    expect(updatedIssue.pairGroupId).toBe(group.id);
  });

  // Team autonomy: company.pairAutoRunDefault decides the default
  // autoRunEnabled for new pair groups; an explicit input always wins.
  it("create() defaults autoRunEnabled from company.pairAutoRunDefault", async () => {
    // Default company (pairAutoRunDefault=true) → group auto-runs.
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId });
    expect(group.autoRunEnabled).toBe(true);

    // Company that opted out → new groups default to autoRunEnabled=false.
    const optOutCompanyId = randomUUID();
    await db.insert(companies).values({
      id: optOutCompanyId,
      name: "Workcell opt-out",
      issuePrefix: ("WX" + optOutCompanyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
      pairAutoRunDefault: false,
    });
    const optOutIssueId = randomUUID();
    await db.insert(issues).values({
      id: optOutIssueId,
      companyId: optOutCompanyId,
      title: "Pair candidate (opt-out company)",
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });
    const optOutGroup = await svc.create({ companyId: optOutCompanyId, issueId: optOutIssueId });
    expect(optOutGroup.autoRunEnabled).toBe(false);
  });

  it("create() lets an explicit autoRunEnabled input override the company default", async () => {
    const optOutCompanyId = randomUUID();
    await db.insert(companies).values({
      id: optOutCompanyId,
      name: "Workcell opt-out explicit",
      issuePrefix: ("WY" + optOutCompanyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
      pairAutoRunDefault: false,
    });
    const optOutIssueId = randomUUID();
    await db.insert(issues).values({
      id: optOutIssueId,
      companyId: optOutCompanyId,
      title: "Pair candidate (explicit override)",
      status: "todo",
      priority: "medium",
      workMode: "standard",
    });

    // Explicit true beats the company-level false default.
    const group = await svc.create({
      companyId: optOutCompanyId,
      issueId: optOutIssueId,
      autoRunEnabled: true,
    });
    expect(group.autoRunEnabled).toBe(true);

    // And the inverse: explicit false beats the default-true company.
    const issueId = await seedIssue();
    const offGroup = await svc.create({ companyId, issueId, autoRunEnabled: false });
    expect(offGroup.autoRunEnabled).toBe(false);
  });

  it("create() honors a custom maxRounds and stopPolicy", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      maxRounds: 5,
      stopPolicy: { maxRounds: 5, abortOn: ["executor_aborted"], requireConvergence: true },
    });
    expect(group.maxRounds).toBe(5);
    expect(group.stopPolicy).toEqual({
      maxRounds: 5,
      abortOn: ["executor_aborted"],
      requireConvergence: true,
    });
  });

  it("getById() scopes to company (cross-company lookup returns null)", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId });

    const otherCompanyId = randomUUID();
    expect(await svc.getById(otherCompanyId, group.id)).toBeNull();
    expect(await svc.getById(companyId, group.id)).not.toBeNull();
  });

  it("getActiveForIssue() returns only the active group, skipping completed/aborted", async () => {
    const issueId = await seedIssue();
    // Seed a completed group first.
    const old = await svc.create({ companyId, issueId });
    await svc.transitionStatus({
      companyId,
      id: old.id,
      status: "completed",
      stopReason: "agreed_on_solution",
    });

    // Reset workOwnerKind so a fresh create can run cleanly (orchestration
    // re-flips it). In real usage the issue would be in a fresh state.
    await db
      .update(issues)
      .set({ workOwnerKind: "single", pairGroupId: null })
      .where(eq(issues.id, issueId));

    const fresh = await svc.create({ companyId, issueId });

    const active = await svc.getActiveForIssue(companyId, issueId);
    expect(active?.id).toBe(fresh.id);
  });

  it("transitionStatus() to completed sets stopReason and completedAt", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId });
    expect(group.completedAt).toBeNull();

    const updated = await svc.transitionStatus({
      companyId,
      id: group.id,
      status: "completed",
      stopReason: "agreed_on_solution",
    });
    expect(updated?.status).toBe("completed");
    expect(updated?.stopReason).toBe("agreed_on_solution");
    expect(updated?.completedAt).not.toBeNull();
  });

  // ---------- WC-25: PairTurn + round advancement ----------

  it("WC-25: recordTurn inserts a pair_turns row scoped to the current round and adds cost", async () => {
    const ownerId = await seedAgent("planner");
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId, ownerAgentId: ownerId });

    const result = await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      summary: "Initial draft",
      outcome: "delivered",
      costCents: 250,
    });
    expect(result.turn.round).toBe(0);
    expect(result.turn.actorAgentId).toBe(ownerId);
    expect(result.turn.outcome).toBe("delivered");
    expect(result.group?.status).toBe("active");
    expect(result.group?.totalCostCents).toBe(250);
  });

  it("WC-128: recordTurn degrades gracefully on a duplicate (group,round,actor) — concurrent run-round race", async () => {
    const ownerId = await seedAgent("planner");
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId, ownerAgentId: ownerId });

    const first = await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      summary: "draft",
      outcome: "delivered",
      costCents: 100,
    });
    expect(first.turn?.round).toBe(0);

    // A second call records the SAME (group, round 0, owner) before the round
    // advanced — exactly what two concurrent run-round requests would do. The
    // unique index would otherwise throw a 500; recordTurn must no-op cleanly.
    const dup = await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      summary: "dup",
      outcome: "delivered",
      costCents: 100,
    });
    expect(dup.turn).toBeNull();
    expect(dup.conflict).toBe(true);
    // No double-billing: only the first turn's cost is counted.
    expect(dup.group?.totalCostCents).toBe(100);
  });

  it("WC-25: advanceRound bumps currentRound by 1, refuses past maxRounds", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId, maxRounds: 2 });

    const a = await svc.advanceRound({ companyId, pairGroupId: group.id });
    expect(a?.currentRound).toBe(1);
    const b = await svc.advanceRound({ companyId, pairGroupId: group.id });
    expect(b?.currentRound).toBe(2);
    // Past max → unchanged.
    const c = await svc.advanceRound({ companyId, pairGroupId: group.id });
    expect(c?.currentRound).toBe(2);
  });

  it("WC-25: outcome=abort auto-transitions group to aborted with actor reason", async () => {
    const ownerId = await seedAgent("planner");
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId, ownerAgentId: ownerId });

    const result = await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      outcome: "abort",
      summary: "Cannot proceed",
    });
    expect(result.group?.status).toBe("aborted");
    expect(result.group?.stopReason).toContain("actor_abort:");
  });

  it("WC-25: requireConvergence + no_change after a delivered counterpart turn completes the group", async () => {
    const ownerId = await seedAgent("planner");
    const counterpartId = await seedAgent("engineer");
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      stopPolicy: { requireConvergence: true },
    });

    // Owner delivers in round 0.
    await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      outcome: "delivered",
      summary: "Plan",
    });
    // Counterpart signals no_change → convergence reached.
    const second = await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: counterpartId,
      outcome: "no_change",
      summary: "LGTM",
    });
    expect(second.group?.status).toBe("completed");
    expect(second.group?.stopReason).toBe("convergence_reached");
  });

  it("convergence is DEFAULT ON: a group created without a stopPolicy completes on no_change after a delivered turn", async () => {
    const ownerId = await seedAgent("planner");
    const counterpartId = await seedAgent("engineer");
    const issueId = await seedIssue();
    // No stopPolicy at all (e.g. onboarding-created pair) — previously such a
    // group never converged and burned rounds until maxRounds → aborted.
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
    });

    await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      outcome: "delivered",
      summary: "Plan",
    });
    const second = await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: counterpartId,
      outcome: "no_change",
      summary: "LGTM",
    });
    expect(second.group?.status).toBe("completed");
    expect(second.group?.stopReason).toBe("convergence_reached");
  });

  it("requireConvergence:false opts OUT — no_change does not complete the group", async () => {
    const ownerId = await seedAgent("planner");
    const counterpartId = await seedAgent("engineer");
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      stopPolicy: { requireConvergence: false },
    });

    await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      outcome: "delivered",
      summary: "Plan",
    });
    const second = await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: counterpartId,
      outcome: "no_change",
      summary: "LGTM",
    });
    expect(second.turn).not.toBeNull();
    expect(second.group?.status).toBe("active");
    expect(second.group?.stopReason).toBeNull();
  });

  it("bidirectional sign-off: owner no_change in round N converges on the counterpart's round N-1 delivered work", async () => {
    const ownerId = await seedAgent("planner");
    const counterpartId = await seedAgent("engineer");
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
    });

    // Round 0: owner delivers, counterpart directly improves (delivered).
    await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      outcome: "delivered",
      summary: "Plan v1",
    });
    await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: counterpartId,
      outcome: "delivered",
      summary: "Fixed the plan myself",
    });
    await svc.advanceRound({ companyId, pairGroupId: group.id });

    // Round 1: the owner opens the round by signing off on the counterpart's
    // latest delivered work — convergence fires CROSS-ROUND, mid-round.
    const signOff = await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      outcome: "no_change",
      summary: "Counterpart's improvements complete the work",
    });
    expect(signOff.group?.status).toBe("completed");
    expect(signOff.group?.stopReason).toBe("convergence_reached");
  });

  it("no_change with NO turn from the other participant does not converge (group stays active)", async () => {
    const ownerId = await seedAgent("planner");
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId, ownerAgentId: ownerId });

    // Round 0, zero prior turns: nothing to sign off on.
    const first = await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      outcome: "no_change",
      summary: "nothing to do?",
    });
    expect(first.turn).not.toBeNull();
    expect(first.group?.status).toBe("active");

    // The actor's OWN earlier delivered turn must not count as the other
    // side's work either.
    await svc.advanceRound({ companyId, pairGroupId: group.id });
    await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      outcome: "delivered",
      summary: "own work",
    });
    await svc.advanceRound({ companyId, pairGroupId: group.id });
    const selfOk = await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      outcome: "no_change",
      summary: "I approve myself",
    });
    expect(selfOk.group?.status).toBe("active");
    expect(selfOk.group?.stopReason).toBeNull();
  });

  it("requireConvergence:false also ignores a CROSS-ROUND sign-off", async () => {
    const ownerId = await seedAgent("planner");
    const counterpartId = await seedAgent("engineer");
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
      stopPolicy: { requireConvergence: false },
    });

    await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      outcome: "delivered",
      summary: "Plan",
    });
    await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: counterpartId,
      outcome: "delivered",
      summary: "Improved directly",
    });
    await svc.advanceRound({ companyId, pairGroupId: group.id });
    const ok = await svc.recordTurn({
      companyId,
      pairGroupId: group.id,
      actorAgentId: ownerId,
      outcome: "no_change",
      summary: "LGTM",
    });
    expect(ok.turn).not.toBeNull();
    expect(ok.group?.status).toBe("active");
    expect(ok.group?.stopReason).toBeNull();
  });

  it("WC-25: listTurnsForGroup returns rows in (round, createdAt) order", async () => {
    const ownerId = await seedAgent("planner");
    const counterpartId = await seedAgent("engineer");
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      ownerAgentId: ownerId,
      counterpartAgentId: counterpartId,
    });
    await svc.recordTurn({ companyId, pairGroupId: group.id, actorAgentId: ownerId, summary: "r0-o" });
    await svc.recordTurn({ companyId, pairGroupId: group.id, actorAgentId: counterpartId, summary: "r0-c" });
    await svc.advanceRound({ companyId, pairGroupId: group.id });
    await svc.recordTurn({ companyId, pairGroupId: group.id, actorAgentId: ownerId, summary: "r1-o" });

    const turns = await svc.listTurnsForGroup(companyId, group.id);
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.round)).toEqual([0, 0, 1]);
    expect(turns.map((t) => t.summary)).toEqual(["r0-o", "r0-c", "r1-o"]);
  });

  it("WC-52: recordTurn at the round cap aborts WITHOUT recording or billing a turn", async () => {
    const ownerId = await seedAgent("planner");
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId, ownerAgentId: ownerId, maxRounds: 1 });

    // Round 0 is within budget (0 < 1): records + bills.
    const first = await svc.recordTurn({
      companyId, pairGroupId: group.id, actorAgentId: ownerId, summary: "r0", costCents: 100,
    });
    expect(first.turn).not.toBeNull();
    expect(first.group?.totalCostCents).toBe(100);

    // Advance to currentRound=1 (== cap). The next turn is over budget.
    await svc.advanceRound({ companyId, pairGroupId: group.id });

    const overflow = await svc.recordTurn({
      companyId, pairGroupId: group.id, actorAgentId: ownerId, summary: "overflow", costCents: 999,
    });
    // No turn recorded, no cost billed, group aborted with max_rounds_reached.
    expect(overflow.turn).toBeNull();
    expect(overflow.group?.status).toBe("aborted");
    expect(overflow.group?.stopReason).toBe("max_rounds_reached");
    expect(overflow.group?.totalCostCents).toBe(100); // 999 NOT billed

    const turns = await svc.listTurnsForGroup(companyId, group.id);
    expect(turns).toHaveLength(1); // only the in-budget round-0 turn
  });

  it("WC-52: stopPolicy.maxRounds overrides the column for the cap", async () => {
    const ownerId = await seedAgent("planner");
    const issueId = await seedIssue();
    // Column maxRounds=10, but stopPolicy caps at 1.
    const group = await svc.create({
      companyId, issueId, ownerAgentId: ownerId, maxRounds: 10,
      stopPolicy: { maxRounds: 1 },
    });
    await svc.recordTurn({ companyId, pairGroupId: group.id, actorAgentId: ownerId, summary: "r0" });
    await svc.advanceRound({ companyId, pairGroupId: group.id });
    const overflow = await svc.recordTurn({
      companyId, pairGroupId: group.id, actorAgentId: ownerId, summary: "r1",
    });
    expect(overflow.turn).toBeNull();
    expect(overflow.group?.status).toBe("aborted");
    expect(overflow.group?.stopReason).toBe("max_rounds_reached");
  });

  it("WC-52: convergence is reachable on the final valid round (not pre-empted by the cap)", async () => {
    const ownerId = await seedAgent("planner");
    const counterpartId = await seedAgent("engineer");
    const issueId = await seedIssue();
    // maxRounds=1 → the only valid round is round 0. Convergence must still work there.
    const group = await svc.create({
      companyId, issueId, ownerAgentId: ownerId, counterpartAgentId: counterpartId,
      maxRounds: 1, stopPolicy: { requireConvergence: true },
    });
    await svc.recordTurn({ companyId, pairGroupId: group.id, actorAgentId: ownerId, outcome: "delivered", summary: "plan" });
    const second = await svc.recordTurn({ companyId, pairGroupId: group.id, actorAgentId: counterpartId, outcome: "no_change", summary: "LGTM" });
    expect(second.group?.status).toBe("completed");
    expect(second.group?.stopReason).toBe("convergence_reached");
  });

  it("WC-52: stopPolicy.abortOn aborts on a configured outcome", async () => {
    const ownerId = await seedAgent("planner");
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId, issueId, ownerAgentId: ownerId,
      stopPolicy: { abortOn: ["no_change"] },
    });
    const result = await svc.recordTurn({
      companyId, pairGroupId: group.id, actorAgentId: ownerId, outcome: "no_change", summary: "pass",
    });
    expect(result.group?.status).toBe("aborted");
    expect(result.group?.stopReason).toBe("abort_policy:no_change");
  });

  it("WC-25: recordTurn rejects when the group is not active", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId });
    await svc.transitionStatus({ companyId, id: group.id, status: "completed", stopReason: "done" });

    await expect(
      svc.recordTurn({
        companyId,
        pairGroupId: group.id,
        actorAgentId: null,
      }),
    ).rejects.toThrow(/status="completed"/);
  });

  it("transitionStatus() to aborted captures reason; back-to-active clears completedAt", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({ companyId, issueId });

    const aborted = await svc.transitionStatus({
      companyId,
      id: group.id,
      status: "aborted",
      stopReason: "max_rounds_reached",
    });
    expect(aborted?.status).toBe("aborted");
    expect(aborted?.completedAt).not.toBeNull();

    // Defensive — if orchestration ever needs to resume an aborted group,
    // the back-to-active transition must clear completedAt.
    const reopened = await svc.transitionStatus({
      companyId,
      id: group.id,
      status: "active",
      stopReason: null,
    });
    expect(reopened?.status).toBe("active");
    expect(reopened?.completedAt).toBeNull();
    expect(reopened?.stopReason).toBeNull();
  });
});
