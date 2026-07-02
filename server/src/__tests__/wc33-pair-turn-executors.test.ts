import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, executionWorkspaces, issues, projects } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildPairTurnAdapterConfig,
  buildPairTurnExecutor,
  buildPairTurnPrompt,
  coercePairTurnAdapterConfig,
  parsePairTurnResponse,
  stubPairTurnInvoke,
} from "../services/pair-turn-executors.ts";

// ---------- Pure helpers ----------
describe("WC-33 buildPairTurnPrompt", () => {
  it("includes role, round, agent identity, and counterpart context", () => {
    const prompt = buildPairTurnPrompt({
      request: {
        pairGroupId: "g",
        companyId: "c",
        round: 2,
        actorAgentId: "a",
        role: "counterpart",
        previousTurnSummary: "Owner proposes X.",
      },
      issue: { title: "Pair candidate", description: "Needs second eye" },
      agent: { name: "Ada", role: "engineer" },
      maxRounds: 10,
    });
    expect(prompt).toContain("Ada");
    expect(prompt).toContain("counterpart");
    expect(prompt).toContain("round 3 of at most 10");
    expect(prompt).toContain("Owner proposes X.");
    expect(prompt).toContain("Pair candidate");
    expect(prompt).toContain("Needs second eye");
    expect(prompt).toContain("OUTCOME: no_change");
    expect(prompt).toContain("OUTCOME: abort");
    // Working reviewer: the counterpart is told to MAKE corrections itself
    // (it has full tool access), not merely point them out — and no_change
    // is reserved for true sign-off.
    expect(prompt).toContain("MAKE them yourself");
    expect(prompt).toContain("ONLY when the owner's latest work needs nothing more");
    // Role-accurate label: the counterpart receives the OWNER's proposal —
    // the old generic "from counterpart" header was wrong for this role.
    expect(prompt).toContain("## Owner's proposal this round");
    expect(prompt).not.toContain("from counterpart");
  });

  it("labels the previous turn as the counterpart's review when the owner is the actor", () => {
    const prompt = buildPairTurnPrompt({
      request: {
        pairGroupId: "g",
        companyId: "c",
        round: 1,
        actorAgentId: "a",
        role: "owner",
        previousTurnSummary: "Tighten the scope before round 2.",
      },
      issue: null,
      agent: { name: "Owner", role: "planner" },
      maxRounds: 5,
    });
    expect(prompt).toContain("## Counterpart's review of your previous proposal");
    expect(prompt).toContain("Tighten the scope before round 2.");
    expect(prompt).toContain("Address this feedback in your next proposal.");
    expect(prompt).toContain("If the counterpart's review above raises issues, address them with actual changes.");
    expect(prompt).not.toContain("from counterpart");
  });

  it("renders the round history section (oldest first) with truncated summaries", () => {
    const longSummary = "x".repeat(250);
    const prompt = buildPairTurnPrompt({
      request: {
        pairGroupId: "g",
        companyId: "c",
        round: 2,
        actorAgentId: "a",
        role: "owner",
        previousTurnSummary: "Latest review.",
        recentTurns: [
          { round: 0, role: "owner", outcome: "delivered", summary: "Proposal A" },
          { round: 0, role: "counterpart", outcome: "delivered", summary: "Review A" },
          { round: 1, role: "owner", outcome: "delivered", summary: longSummary },
          { round: 1, role: "counterpart", outcome: "delivered", summary: null },
        ],
      },
      issue: { title: "Pair candidate", description: null },
      agent: { name: "Owner", role: "planner" },
      maxRounds: 10,
    });
    expect(prompt).toContain("## Round history (oldest first)");
    expect(prompt).toContain("- Round 1 · owner (delivered): Proposal A");
    expect(prompt).toContain("- Round 1 · counterpart (delivered): Review A");
    // Summaries are truncated to 200 chars; null summaries render empty.
    expect(prompt).toContain(`- Round 2 · owner (delivered): ${"x".repeat(200)}`);
    expect(prompt).not.toContain("x".repeat(201));
    expect(prompt).toContain("- Round 2 · counterpart (delivered): ");
    // History comes after issue context but before the emphasized previous-turn section.
    expect(prompt.indexOf("## Issue context")).toBeLessThan(prompt.indexOf("## Round history"));
    expect(prompt.indexOf("## Round history")).toBeLessThan(
      prompt.indexOf("## Counterpart's review of your previous proposal"),
    );
  });

  it("omits the round history section when recentTurns is absent or empty", () => {
    const base = {
      pairGroupId: "g",
      companyId: "c",
      round: 0,
      actorAgentId: "a",
      role: "owner" as const,
      previousTurnSummary: null,
    };
    const withoutField = buildPairTurnPrompt({
      request: base,
      issue: null,
      agent: { name: "Owner", role: "planner" },
      maxRounds: 5,
    });
    expect(withoutField).not.toContain("## Round history");
    const withEmpty = buildPairTurnPrompt({
      request: { ...base, recentTurns: [] },
      issue: null,
      agent: { name: "Owner", role: "planner" },
      maxRounds: 5,
    });
    expect(withEmpty).not.toContain("## Round history");
  });

  it("uses owner-specific copy for round 0 with no previous turn", () => {
    const prompt = buildPairTurnPrompt({
      request: {
        pairGroupId: "g",
        companyId: "c",
        round: 0,
        actorAgentId: "a",
        role: "owner",
        previousTurnSummary: null,
      },
      issue: null,
      agent: { name: "Owner", role: "planner" },
      maxRounds: 5,
    });
    expect(prompt).toContain("round 1 of at most 5");
    // Pairs work, not just deliberate: the owner is told to advance the issue
    // with its tools in this turn and report what it DID.
    expect(prompt).toContain("ADVANCE the issue concretely NOW");
    expect(prompt).toContain("report what you DID this turn");
    // Bidirectional sign-off: the owner can also end the pair by approving
    // the counterpart's latest delivered work.
    expect(prompt).toContain(
      "say `OUTCOME: no_change` on its own line to sign off — this ends the pair",
    );
    expect(prompt).not.toContain("Previous turn");
  });
});

describe("WC-33 parsePairTurnResponse", () => {
  it("defaults to delivered when no OUTCOME marker is present", () => {
    expect(parsePairTurnResponse("Let's split the work into halves.")).toEqual({
      summary: "Let's split the work into halves.",
      outcome: "delivered",
    });
  });

  it("extracts OUTCOME: no_change and strips the marker line", () => {
    const r = parsePairTurnResponse(
      "Looks great as written.\nOUTCOME: no_change\n",
    );
    expect(r.outcome).toBe("no_change");
    expect(r.summary).toBe("Looks great as written.");
  });

  it("extracts OUTCOME: abort case-insensitively", () => {
    const r = parsePairTurnResponse(
      "We've hit a wall.\noutcome: ABORT — third-party API is down.\n",
    );
    expect(r.outcome).toBe("abort");
    expect(r.summary).toBe("We've hit a wall.");
  });
});

// ---------- WC-97: adapter-config (model) parity helper ----------
describe("WC-97 buildPairTurnAdapterConfig", () => {
  it("forwards plain config (model) and strips env (unresolved secret bindings)", () => {
    expect(
      buildPairTurnAdapterConfig({
        model: "claude-opus-4-8",
        thinkingEffort: "high",
        env: { ANTHROPIC_API_KEY: { type: "secret", secretId: "s1" } },
      }),
    ).toEqual({ model: "claude-opus-4-8", thinkingEffort: "high" });
  });

  it("parses a JSON-string config", () => {
    expect(buildPairTurnAdapterConfig('{"model":"m1"}')).toEqual({ model: "m1" });
  });

  it("returns {} for null / non-object / bad JSON / array", () => {
    expect(buildPairTurnAdapterConfig(null)).toEqual({});
    expect(buildPairTurnAdapterConfig(42)).toEqual({});
    expect(buildPairTurnAdapterConfig("not json")).toEqual({});
    expect(buildPairTurnAdapterConfig(["a"])).toEqual({});
  });
});

// ---------- WC-125: env-keeping coerce (resolver input) ----------
describe("WC-125 coercePairTurnAdapterConfig", () => {
  it("KEEPS env (so the secret resolver can resolve it) unlike buildPairTurnAdapterConfig", () => {
    const raw = { model: "m1", env: { ANTHROPIC_API_KEY: { type: "secret", secretId: "s1" } } };
    expect(coercePairTurnAdapterConfig(raw)).toEqual(raw);
    // contrast: the strip helper drops env
    expect(buildPairTurnAdapterConfig(raw)).toEqual({ model: "m1" });
  });

  it("parses a JSON-string config and returns {} for junk", () => {
    expect(coercePairTurnAdapterConfig('{"model":"m1","env":{"K":"v"}}')).toEqual({
      model: "m1",
      env: { K: "v" },
    });
    expect(coercePairTurnAdapterConfig(null)).toEqual({});
    expect(coercePairTurnAdapterConfig("not json")).toEqual({});
    expect(coercePairTurnAdapterConfig(["a"])).toEqual({});
  });
});

// ---------- DB-backed executor wrapper ----------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-33 pair-turn executor embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-33 buildPairTurnExecutor wraps an invoke fn with agent lookup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc33-pair-turn-exec-");
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
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ada",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
    });
  });

  afterEach(async () => {
    await db.execute("truncate table companies, agents, issues restart identity cascade" as any);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves the agent, builds a prompt, and forwards to invoke", async () => {
    const invoke = vi.fn(async () => ({
      summary: "All set.",
      outcome: "delivered" as const,
      costCents: 12,
    }));
    const exec = buildPairTurnExecutor(db, invoke);
    const result = await exec({
      pairGroupId: randomUUID(),
      companyId,
      round: 1,
      actorAgentId: agentId,
      role: "counterpart",
      previousTurnSummary: "Owner says do X.",
    });
    expect(result.summary).toBe("All set.");
    expect(result.costCents).toBe(12);

    const invokeCall = invoke.mock.calls[0][0];
    expect(invokeCall.agent.name).toBe("Ada");
    expect(invokeCall.agent.role).toBe("engineer");
    expect(invokeCall.promptText).toContain("counterpart");
    expect(invokeCall.promptText).toContain("Owner says do X.");
  });

  it("WC-97: forwards the agent's configured adapterConfig (model) with env stripped", async () => {
    const modelAgentId = randomUUID();
    await db.insert(agents).values({
      id: modelAgentId,
      companyId,
      name: "Mira",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-opus-4-8",
        env: { ANTHROPIC_API_KEY: { type: "secret", secretId: "s1", version: 1 } },
      },
    });
    const invoke = vi.fn(async () => ({ summary: "ok", outcome: "delivered" as const }));
    const exec = buildPairTurnExecutor(db, invoke);
    await exec({
      pairGroupId: randomUUID(),
      companyId,
      round: 0,
      actorAgentId: modelAgentId,
      role: "owner",
      previousTurnSummary: null,
    });
    const call = invoke.mock.calls[0][0];
    // model is forwarded; env (unresolved secret binding) is stripped.
    expect(call.agent.adapterConfig).toEqual({ model: "claude-opus-4-8" });
  });

  it("WC-125: when a resolver is injected, env-secrets are RESOLVED (not stripped) and reach invoke", async () => {
    const secretAgentId = randomUUID();
    await db.insert(agents).values({
      id: secretAgentId,
      companyId,
      name: "Nova",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-opus-4-8",
        env: { ANTHROPIC_API_KEY: { type: "secret", secretId: "s1", version: 1 } },
      },
    });
    // Stand-in for secretService.resolveAdapterConfigForRuntime: turns the
    // binding into a plain value. Asserts it receives the env-KEEPING coerced
    // config (so the real resolver can see the bindings).
    const resolveAdapterConfig = vi.fn(async (cid: string, raw: unknown) => {
      expect(cid).toBe(companyId);
      expect((raw as { env?: unknown }).env).toBeTruthy(); // env preserved for resolution
      return { model: "claude-opus-4-8", env: { ANTHROPIC_API_KEY: "sk-resolved" } };
    });
    const invoke = vi.fn(async () => ({ summary: "ok", outcome: "delivered" as const }));
    const exec = buildPairTurnExecutor(db, invoke, { resolveAdapterConfig });
    await exec({
      pairGroupId: randomUUID(),
      companyId,
      round: 0,
      actorAgentId: secretAgentId,
      role: "owner",
      previousTurnSummary: null,
    });
    expect(resolveAdapterConfig).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0].agent.adapterConfig).toEqual({
      model: "claude-opus-4-8",
      env: { ANTHROPIC_API_KEY: "sk-resolved" },
    });
  });

  it("WC-125: a resolver failure degrades to the safe stripped config (never 500s a round)", async () => {
    const secretAgentId = randomUUID();
    await db.insert(agents).values({
      id: secretAgentId,
      companyId,
      name: "Vex",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        model: "m9",
        env: { ANTHROPIC_API_KEY: { type: "secret", secretId: "missing" } },
      },
    });
    const resolveAdapterConfig = vi.fn(async () => {
      throw new Error("secret not found");
    });
    const invoke = vi.fn(async () => ({ summary: "ok", outcome: "delivered" as const }));
    const exec = buildPairTurnExecutor(db, invoke, { resolveAdapterConfig });
    await exec({
      pairGroupId: randomUUID(),
      companyId,
      round: 0,
      actorAgentId: secretAgentId,
      role: "owner",
      previousTurnSummary: null,
    });
    // Fell back to the stripped config (model kept, env dropped) — no throw.
    expect(invoke.mock.calls[0][0].agent.adapterConfig).toEqual({ model: "m9" });
  });

  it("throws a clear error when the agent does not belong to the company", async () => {
    const exec = buildPairTurnExecutor(db, async () => ({
      summary: "x",
      outcome: "delivered",
    }));
    await expect(
      exec({
        pairGroupId: "g",
        companyId: randomUUID(), // wrong company
        round: 0,
        actorAgentId: agentId,
        role: "owner",
        previousTurnSummary: null,
      }),
    ).rejects.toThrow(/agent .* not found/);
  });

  it("stubPairTurnInvoke produces a deterministic delivered turn", async () => {
    const exec = buildPairTurnExecutor(db, stubPairTurnInvoke);
    const result = await exec({
      pairGroupId: randomUUID(),
      companyId,
      round: 0,
      actorAgentId: agentId,
      role: "owner",
      previousTurnSummary: null,
    });
    expect(result.outcome).toBe("delivered");
    expect(result.summary).toContain("[stub]");
    expect(result.summary).toContain("Ada");
    expect(result.summary).toContain("owner");
  });

  // ---------- WC-59: issue grounding ----------

  it("WC-59: grounds the prompt in the issue bound to the pair group (by pairGroupId)", async () => {
    const pairGroupId = randomUUID();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Refactor the auth module",
      description: "Split the 800-line auth service into testable units.",
      status: "in_progress",
      priority: "high",
      workMode: "standard",
      pairGroupId,
    });
    const invoke = vi.fn(async () => ({ summary: "ok", outcome: "delivered" as const }));
    const exec = buildPairTurnExecutor(db, invoke);
    await exec({
      pairGroupId,
      companyId,
      round: 0,
      actorAgentId: agentId,
      role: "owner",
      previousTurnSummary: null,
    });
    const call = invoke.mock.calls[0][0];
    expect(call.issue).toMatchObject({ id: issueId, title: "Refactor the auth module" });
    expect(call.promptText).toContain("Refactor the auth module");
    expect(call.promptText).toContain("Split the 800-line auth service");
  });

  it("WC-59: degrades to a null-issue prompt when no issue references the group", async () => {
    const invoke = vi.fn(async () => ({ summary: "ok", outcome: "delivered" as const }));
    const exec = buildPairTurnExecutor(db, invoke);
    await exec({
      pairGroupId: randomUUID(), // no issue points at this group
      companyId,
      round: 0,
      actorAgentId: agentId,
      role: "owner",
      previousTurnSummary: null,
    });
    const call = invoke.mock.calls[0][0];
    expect(call.issue).toBeNull();
    expect(call.promptText).not.toContain("## Issue context");
  });

  it("WC-59: does NOT ground from a cross-tenant issue with the same pairGroupId", async () => {
    // An issue in ANOTHER company sharing the pairGroupId must not leak into
    // this company's pair turn — the lookup is tenant-scoped (companyId AND
    // pairGroupId).
    const pairGroupId = randomUUID();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: "OTH",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: otherCompanyId,
      title: "Foreign issue",
      description: "Should never appear",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      pairGroupId,
    });
    const invoke = vi.fn(async () => ({ summary: "ok", outcome: "delivered" as const }));
    const exec = buildPairTurnExecutor(db, invoke);
    await exec({
      pairGroupId,
      companyId, // our company has no issue with this pairGroupId
      round: 0,
      actorAgentId: agentId,
      role: "owner",
      previousTurnSummary: null,
    });
    const call = invoke.mock.calls[0][0];
    expect(call.issue).toBeNull();
    expect(call.promptText).not.toContain("Foreign issue");
  });

  // ---------- WC-103: existing-workspace cwd grounding ----------

  it("WC-103: grounds the turn in the issue's existing execution workspace cwd", async () => {
    const pairGroupId = randomUUID();
    const issueId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Repo project" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Code issue",
      description: "Has a materialized workspace",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      projectId,
      pairGroupId,
    });
    await db.insert(executionWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "ws-pair",
      status: "active",
      cwd: "/tmp/workcell/ws-pair",
    });
    const invoke = vi.fn(async () => ({ summary: "ok", outcome: "delivered" as const }));
    const exec = buildPairTurnExecutor(db, invoke);
    await exec({
      pairGroupId,
      companyId,
      round: 0,
      actorAgentId: agentId,
      role: "owner",
      previousTurnSummary: null,
    });
    expect(invoke.mock.calls[0][0].workspaceCwd).toBe("/tmp/workcell/ws-pair");
  });

  it("WC-103: workspaceCwd is null when the issue has no execution workspace", async () => {
    const pairGroupId = randomUUID();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No workspace",
      description: "x",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      pairGroupId,
    });
    const invoke = vi.fn(async () => ({ summary: "ok", outcome: "delivered" as const }));
    const exec = buildPairTurnExecutor(db, invoke);
    await exec({
      pairGroupId,
      companyId,
      round: 0,
      actorAgentId: agentId,
      role: "owner",
      previousTurnSummary: null,
    });
    expect(invoke.mock.calls[0][0].workspaceCwd ?? null).toBeNull();
  });

  // ---------- WC-132 (D21 slice 3): ensureWorkspace reuse-or-realize wiring ----------

  it("WC-132: when ensureWorkspace is injected, its realized cwd is used (reuse-or-realize)", async () => {
    const pairGroupId = randomUUID();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Editable",
      description: "x",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      pairGroupId,
    });
    const ensureWorkspace = vi.fn(async () => ({ cwd: "/tmp/workcell/pair-worktree" }));
    const invoke = vi.fn(async () => ({ summary: "ok", outcome: "delivered" as const }));
    const exec = buildPairTurnExecutor(db, invoke, { ensureWorkspace });
    await exec({
      pairGroupId,
      companyId,
      round: 0,
      actorAgentId: agentId,
      role: "owner",
      previousTurnSummary: null,
    });
    expect(ensureWorkspace).toHaveBeenCalledWith(
      companyId,
      issueId,
      expect.objectContaining({ id: agentId, name: "Ada", companyId }),
      pairGroupId,
    );
    expect(invoke.mock.calls[0][0].workspaceCwd).toBe("/tmp/workcell/pair-worktree");
  });

  it("WC-132: an ensureWorkspace failure degrades to null (the round still runs)", async () => {
    const pairGroupId = randomUUID();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No repo",
      description: "x",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      pairGroupId,
    });
    const ensureWorkspace = vi.fn(async () => {
      throw new Error("realization failed");
    });
    const invoke = vi.fn(async () => ({ summary: "ok", outcome: "delivered" as const }));
    const exec = buildPairTurnExecutor(db, invoke, { ensureWorkspace });
    const result = await exec({
      pairGroupId,
      companyId,
      round: 0,
      actorAgentId: agentId,
      role: "owner",
      previousTurnSummary: null,
    });
    expect(result.outcome).toBe("delivered");
    expect(invoke.mock.calls[0][0].workspaceCwd ?? null).toBeNull();
  });
});
