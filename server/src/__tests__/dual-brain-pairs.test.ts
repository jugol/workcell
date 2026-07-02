import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pairGroupService } from "../services/pair-groups.ts";
import {
  pairRoundOrchestrator,
  type PairTurnExecutor,
  type PairTurnRequest,
} from "../services/pair-round-orchestrator.ts";
import {
  buildPairTurnExecutor,
  type PairTurnInvokeContext,
} from "../services/pair-turn-executors.ts";

// Dual-brain pivot: ONE agent self-reviews across two brains. The pair round
// engine is reused with kind="dual_brain" (owner === counterpart); lane — not
// actorAgentId — is the side identity, and the executor swaps the adapter /
// model per seat from agents.deliberation (brainA = work, brainB = review).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping dual-brain pair embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dual-brain pair groups", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof pairGroupService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-dual-brain-");
    db = createDb(tempDb.connectionString);
    svc = pairGroupService(db);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: ("DB" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Solo",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { model: "base-model" },
      deliberation: {
        enabled: true,
        brainA: { model: "work-model" },
        brainB: { adapter: "codex_local", model: "review-model" },
        maxRounds: 4,
      },
    });
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
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "dual brain target",
      status: "todo",
      priority: "medium",
    });
    return issueId;
  }

  it("create() forces counterpart = owner for dual_brain and infers the kind from same-agent input", async () => {
    const explicit = await svc.create({
      companyId,
      issueId: await seedIssue(),
      kind: "dual_brain",
      ownerAgentId: agentId,
    });
    expect(explicit.kind).toBe("dual_brain");
    expect(explicit.counterpartAgentId).toBe(agentId);

    const inferred = await svc.create({
      companyId,
      issueId: await seedIssue(),
      ownerAgentId: agentId,
      counterpartAgentId: agentId,
    });
    expect(inferred.kind).toBe("dual_brain");
  });

  it("rejects an agent_pair with the same agent on both sides", async () => {
    await expect(
      svc.create({
        companyId,
        issueId: await seedIssue(),
        kind: "agent_pair",
        ownerAgentId: agentId,
        counterpartAgentId: agentId,
      }),
    ).rejects.toThrow(/two different agents/i);
  });

  it("excludes dual_brain groups from binding surfaces (org/standing)", async () => {
    await svc.create({
      companyId,
      issueId: await seedIssue(),
      kind: "dual_brain",
      ownerAgentId: agentId,
    });
    expect(await svc.listBindingsForCompany(companyId)).toEqual([]);
    expect(await svc.listStandingMutualBindings(companyId)).toEqual([]);
  });

  it("excludes dual_brain groups from the auto-run ticker (no lock-free concurrent self-review)", async () => {
    // Phase A: the pair auto-run ticker must NOT drive a dual_brain group — that
    // ran the agent's self-review concurrently with the issue's QA stage. Only
    // agent_pair groups auto-run.
    const dualBrain = await svc.create({
      companyId,
      issueId: await seedIssue(),
      kind: "dual_brain",
      ownerAgentId: agentId,
    });
    const runnable = await svc.listAutoRunnable(50);
    expect(runnable.some((g) => g.id === dualBrain.id)).toBe(false);
  });

  it("runs a full round with the SAME agent in both lanes and converges on the review brain's sign-off", async () => {
    const group = await svc.create({
      companyId,
      issueId: await seedIssue(),
      kind: "dual_brain",
      ownerAgentId: agentId,
    });

    const seen: PairTurnRequest[] = [];
    const executor: PairTurnExecutor = async (request) => {
      seen.push(request);
      return request.role === "owner"
        ? { summary: "did the work", outcome: "delivered" }
        : { summary: "looks solid", outcome: "no_change" };
    };

    const result = await pairRoundOrchestrator(db, executor).runRound({
      companyId,
      pairGroupId: group.id,
    });

    // Both seats ran as the same agent — the lane-keyed unique index admits
    // two turns by one actor in the same round.
    expect(seen.map((r) => r.actorAgentId)).toEqual([agentId, agentId]);
    expect(seen.map((r) => r.role)).toEqual(["owner", "counterpart"]);
    expect(seen.every((r) => r.groupKind === "dual_brain")).toBe(true);

    // Review-brain no_change over the work brain's delivered turn = sign-off.
    expect(result.group?.status).toBe("completed");
    expect(result.group?.stopReason).toBe("convergence_reached");

    const turns = await svc.listTurnsForGroup(companyId, group.id);
    expect(turns.map((t) => t.lane)).toEqual(["owner", "counterpart"]);
  });

  it("aborts the group instead of running a round when the source issue is closed", async () => {
    // Board stop is final: cancelling the issue did not stop its pair group,
    // so the auto-run ticker kept spending rounds on killed work.
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      kind: "dual_brain",
      ownerAgentId: agentId,
    });
    await db
      .update(issues)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(issues.id, issueId));

    let executed = 0;
    const result = await pairRoundOrchestrator(db, async () => {
      executed += 1;
      return { summary: "should not run", outcome: "delivered" as const };
    }).runRound({ companyId, pairGroupId: group.id });

    expect(executed).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.group?.status).toBe("aborted");
    expect(result.group?.stopReason).toBe("issue_cancelled");
  });

  it("executor swaps adapter/model per seat from agents.deliberation", async () => {
    const issueId = await seedIssue();
    const group = await svc.create({
      companyId,
      issueId,
      kind: "dual_brain",
      ownerAgentId: agentId,
    });

    const invoked: Array<Pick<PairTurnInvokeContext, "agent"> & { role: string }> = [];
    const executor = buildPairTurnExecutor(db, async (ctx) => {
      invoked.push({ agent: ctx.agent, role: ctx.request.role });
      return { summary: "ok", outcome: "delivered" };
    });

    const base = {
      pairGroupId: group.id,
      companyId,
      round: 0,
      actorAgentId: agentId,
      groupKind: "dual_brain" as const,
      previousTurnSummary: null,
    };
    await executor({ ...base, role: "owner" });
    await executor({ ...base, role: "counterpart" });

    // Work brain = the agent itself: its own adapter + configured model.
    // A stored brainA (legacy standalone-deliberation field) is IGNORED.
    expect(invoked[0].agent.adapter).toBe("claude_local");
    expect(invoked[0].agent.adapterConfig?.model).toBe("base-model");
    // Review brain (B): cross-vendor adapter + its own model.
    expect(invoked[1].agent.adapter).toBe("codex_local");
    expect(invoked[1].agent.adapterConfig?.model).toBe("review-model");
  });
});
