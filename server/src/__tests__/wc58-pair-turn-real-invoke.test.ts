import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@workcell/db";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "../adapters/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildRealPairTurnInvoke } from "../services/pair-turn-real-invoke.ts";
import { pairRunRegistry } from "../services/pair-run-registry.ts";
import { getRunLogStore } from "../services/run-log-store.ts";
import { stubPairTurnInvoke } from "../services/pair-turn-executors.ts";
import type {
  PairTurnInvokeContext,
} from "../services/pair-turn-executors.ts";
import type { SingleTurnAdapter } from "../services/adapter-single-turn.ts";

// The run-record path persists onLog chunks through the run log store; point
// it at a throwaway dir BEFORE anything caches the store (getRunLogStore is
// module-cached on first call).
process.env.RUN_LOG_BASE_PATH = mkdtempSync(path.join(tmpdir(), "workcell-wc58-run-logs-"));

function ctx(over: Partial<PairTurnInvokeContext> = {}): PairTurnInvokeContext {
  return {
    request: {
      pairGroupId: "pg-1",
      companyId: "co-1",
      round: 0,
      actorAgentId: "agent-1",
      role: "owner",
      previousTurnSummary: null,
    },
    promptText: "Round prompt body.",
    agent: { id: "agent-1", name: "Ada", role: "engineer", adapter: "claude_local" },
    issue: null,
    ...over,
  };
}

function adapterResult(over: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult {
  return { exitCode: 0, signal: null, timedOut: false, ...over };
}

function fakeAdapter(
  impl: (c: AdapterExecutionContext) => Promise<AdapterExecutionResult> | AdapterExecutionResult,
): SingleTurnAdapter {
  return { execute: vi.fn(impl) };
}

describe("WC-58 realPairTurnInvoke", () => {
  it("maps a delivered turn: strips OUTCOME marker, derives outcome + cost", async () => {
    let seen: AdapterExecutionContext | null = null;
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          seen = c;
          // claude-local streams the NDJSON protocol to stdout but reports the
          // CLEAN assistant text via result.summary — model both.
          await c.onLog("stdout", '{"type":"system","subtype":"hook_started"}');
          return adapterResult({
            summary: "Here is the next concrete step.\nOUTCOME: delivered",
            costUsd: 0.42,
            billingType: "metered_api",
          });
        }),
    });

    const res = await invoke(ctx());
    expect(res.outcome).toBe("delivered");
    expect(res.summary).toBe("Here is the next concrete step.");
    expect(res.costCents).toBe(42);
    expect(res.metadata).toMatchObject({ live: true, adapterType: "claude_local" });
    // The round prompt is delivered through context.workcellTaskMarkdown.
    expect(seen).not.toBeNull();
    expect((seen!.context as Record<string, unknown>).workcellTaskMarkdown).toBe("Round prompt body.");
  });

  // WC-210 (finding D — same bug WC-207 fixed for deliberation): the invoker must
  // parse the adapter's CLEAN text (result.summary), NOT raw stdout. For
  // stream-json adapters stdout is the NDJSON protocol stream; feeding it to the
  // parser made the pair "summary" protocol garbage and hid the OUTCOME marker.
  it("WC-210: parses result.summary (clean text) — NOT the raw stream-json stdout", async () => {
    // The OUTCOME marker lives ONLY in the clean summary; stdout is protocol
    // noise that also happens to contain a bogus OUTCOME line to bait the parser.
    const rawStream =
      '{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}\n' +
      "OUTCOME: abort\n" +
      '{"type":"result","subtype":"success","result":"Refine the cache key.\\nOUTCOME: no_change"}';
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          await c.onLog("stdout", rawStream);
          return adapterResult({
            summary: "Refine the cache key.\nOUTCOME: no_change",
            costUsd: 0.2,
            billingType: "metered_api",
          });
        }),
    });

    const res = await invoke(ctx());
    // Outcome + summary come from the CLEAN summary, not the stdout stream.
    expect(res.outcome).toBe("no_change");
    expect(res.summary).toBe("Refine the cache key.");
    // No protocol garbage leaked into the pair summary.
    expect(res.summary).not.toContain("hook_started");
    expect(res.summary).not.toContain("type");
  });

  // WC-210: an adapter that produced no summary degrades to a safe "(no output)"
  // delivered turn (the same graceful fallback the previous stdout path gave).
  it("WC-210: degrades to (no output) delivered when the adapter has no summary", async () => {
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          await c.onLog("stdout", "noise on stdout, no clean summary produced");
          return adapterResult({ summary: null, costUsd: 0, billingType: "subscription" });
        }),
    });
    const res = await invoke(ctx());
    expect(res.summary).toBe("(no output)");
    expect(res.outcome).toBe("delivered");
  });

  it("maps a no_change counterpart turn", async () => {
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          await c.onLog("stdout", '{"type":"result"}');
          return adapterResult({
            summary: "Looks good as proposed.\nOUTCOME: no_change",
            costUsd: 0.1,
            billingType: "metered_api",
          });
        }),
    });
    const res = await invoke(ctx({ agent: { id: "a2", name: "Ben", role: "qa", adapter: "claude_local" } }));
    expect(res.outcome).toBe("no_change");
    expect(res.summary).toBe("Looks good as proposed.");
    expect(res.costCents).toBe(10);
  });

  it("falls back to delivered when no OUTCOME marker is present", async () => {
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          await c.onLog("stdout", '{"type":"result"}');
          return adapterResult({
            summary: "Just a plain proposal with no marker.",
            costUsd: 0,
            billingType: "subscription",
          });
        }),
    });
    const res = await invoke(ctx());
    expect(res.outcome).toBe("delivered");
    expect(res.summary).toBe("Just a plain proposal with no marker.");
    // subscription billing → 0 cents
    expect(res.costCents).toBe(0);
  });

  it("aborts (gracefully) on a non-zero exit code, still billing cost", async () => {
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          await c.onLog("stdout", "partial");
          return adapterResult({ exitCode: 2, costUsd: 0.05, billingType: "metered_api" });
        }),
    });
    const res = await invoke(ctx());
    expect(res.outcome).toBe("abort");
    expect(res.summary).toContain("[adapter failure]");
    expect(res.costCents).toBe(5);
    expect(res.metadata).toMatchObject({ adapterFailure: true, exitCode: 2 });
  });

  it("aborts on timeout", async () => {
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () => fakeAdapter(async () => adapterResult({ timedOut: true })),
    });
    const res = await invoke(ctx());
    expect(res.outcome).toBe("abort");
    expect(res.summary).toContain("timed out");
  });

  it("aborts when the adapter reports an errorMessage even on exit 0", async () => {
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async () => adapterResult({ exitCode: 0, errorMessage: "model overloaded" })),
    });
    const res = await invoke(ctx());
    expect(res.outcome).toBe("abort");
    expect(res.summary).toContain("model overloaded");
  });

  it("catches a thrown adapter error and converts it to an abort (no 500)", async () => {
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async () => {
          throw new Error("spawn ENOENT");
        }),
    });
    const res = await invoke(ctx());
    expect(res.outcome).toBe("abort");
    expect(res.summary).toContain("[adapter error]");
    expect(res.summary).toContain("spawn ENOENT");
    expect(res.costCents).toBe(0);
    expect(res.metadata).toMatchObject({ adapterError: true });
  });

  it("the stub invoke remains a distinct, deterministic fallback", async () => {
    // Guards the app.ts gating contract: stub stays available + deterministic
    // for the default (no WORKCELL_PAIR_LIVE_LLM) wiring.
    expect(buildRealPairTurnInvoke()).not.toBe(stubPairTurnInvoke);
    const res = await stubPairTurnInvoke(ctx());
    expect(res.outcome).toBe("delivered");
    expect(res.metadata).toMatchObject({ stub: true });
  });

  it("WC-97: runs the turn with the agent's configured model (config.model)", async () => {
    let seen: AdapterExecutionContext | null = null;
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          seen = c;
          await c.onLog("stdout", '{"type":"result"}');
          return adapterResult({
            summary: "Proposed.\nOUTCOME: delivered",
            costUsd: 0,
            billingType: "subscription",
          });
        }),
    });
    await invoke(
      ctx({
        agent: {
          id: "agent-1",
          name: "Ada",
          role: "engineer",
          adapter: "claude_local",
          adapterConfig: { model: "claude-opus-4-8", thinkingEffort: "high" },
        },
      }),
    );
    expect(seen).not.toBeNull();
    // claude-local reads the model from `config` (asString(config.model)).
    expect((seen!.config as Record<string, unknown>).model).toBe("claude-opus-4-8");
    expect((seen!.config as Record<string, unknown>).thinkingEffort).toBe("high");
    // agent.adapterConfig is forwarded too for adapters that read it there.
    expect((seen!.agent as Record<string, unknown>).adapterConfig).toMatchObject({
      model: "claude-opus-4-8",
    });
  });

  it("WC-97: falls back to an empty config when the agent has no adapterConfig", async () => {
    let seen: AdapterExecutionContext | null = null;
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          seen = c;
          await c.onLog("stdout", "ok");
          return adapterResult({ costUsd: 0, billingType: "subscription" });
        }),
    });
    await invoke(ctx()); // ctx agent has no adapterConfig
    expect(seen).not.toBeNull();
    expect(seen!.config).toEqual({});
  });

  it("WC-103: runs in the issue's workspace cwd when present (config.cwd)", async () => {
    let seen: AdapterExecutionContext | null = null;
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          seen = c;
          await c.onLog("stdout", "ok");
          return adapterResult({ costUsd: 0, billingType: "subscription" });
        }),
    });
    await invoke(
      ctx({
        workspaceCwd: "/tmp/workcell/ws-7",
        agent: {
          id: "a",
          name: "Ada",
          role: "engineer",
          adapter: "claude_local",
          adapterConfig: { model: "m1" },
        },
      }),
    );
    expect(seen).not.toBeNull();
    // claude-local resolves its working directory from config.cwd.
    expect((seen!.config as Record<string, unknown>).cwd).toBe("/tmp/workcell/ws-7");
    expect((seen!.config as Record<string, unknown>).model).toBe("m1");
  });

  // JWT parity with heartbeat: a pair turn on a supportsLocalAgentJwt adapter
  // (claude_local / codex_local in the server registry) must receive a local
  // agent JWT as ctx.authToken so the spawned CLI can call the agent API
  // (WORKCELL_API_KEY) instead of 401ing.
  it("JWT parity: issues a local agent JWT and passes it as ctx.authToken", async () => {
    let seen: AdapterExecutionContext | null = null;
    const issueLocalAgentJwt = vi.fn(() => "pair-jwt-token");
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          seen = c;
          await c.onLog("stdout", "ok");
          return adapterResult({
            summary: "Done.\nOUTCOME: delivered",
            costUsd: 0,
            billingType: "subscription",
          });
        }),
      issueLocalAgentJwt,
    });
    const res = await invoke(ctx()); // ctx agent adapter = claude_local → supportsLocalAgentJwt
    expect(res.outcome).toBe("delivered");
    expect(seen).not.toBeNull();
    expect(seen!.authToken).toBe("pair-jwt-token");
    // Issued with the same shape heartbeat uses: (agentId, companyId, adapterType, runId).
    // The runId is a plain uuid (a heartbeat_runs.id on the persisted path) —
    // the old synthetic "pair-<group>-…" string broke issues.checkout_run_id's
    // uuid parse with a 500.
    expect(issueLocalAgentJwt).toHaveBeenCalledTimes(1);
    expect(issueLocalAgentJwt).toHaveBeenCalledWith(
      "agent-1",
      "co-1",
      "claude_local",
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    );
  });

  it("JWT parity: degrades to a token-less turn when issuance returns null", async () => {
    let seen: AdapterExecutionContext | null = null;
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          seen = c;
          await c.onLog("stdout", "ok");
          return adapterResult({
            summary: "Done.\nOUTCOME: delivered",
            costUsd: 0,
            billingType: "subscription",
          });
        }),
      issueLocalAgentJwt: () => null, // jwt secret missing → heartbeat-style degrade
    });
    const res = await invoke(ctx());
    expect(res.outcome).toBe("delivered");
    expect(seen).not.toBeNull();
    expect(seen!.authToken).toBeUndefined();
  });

  it("WC-103: omits cwd when the issue has no workspace (process-cwd fallback)", async () => {
    let seen: AdapterExecutionContext | null = null;
    const invoke = buildRealPairTurnInvoke({
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          seen = c;
          await c.onLog("stdout", "ok");
          return adapterResult({ costUsd: 0, billingType: "subscription" });
        }),
    });
    await invoke(ctx()); // no workspaceCwd
    expect(seen).not.toBeNull();
    expect((seen!.config as Record<string, unknown>).cwd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pair turns promoted to REAL heartbeat_runs records (options.db wiring).
// The synthetic "pair-<group>-…" runId used to flow into the agent JWT and,
// via POST /issues/:id/checkout, into issues.checkout_run_id — a uuid column
// with an FK to heartbeat_runs — which 500ed with a DrizzleQueryError. With
// db provided, each turn now creates/finalizes a real run row and streams its
// adapter output through heartbeat's run-log + lifecycle-event conventions.
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-58 pair-turn run-record embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("WC-58 pair turns as real heartbeat run records", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc58-pair-run-records-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ada",
      role: "engineer",
      status: "idle",
      adapter: "claude_local",
    });
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, heartbeat_runs, heartbeat_run_events restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function dbCtx(over: Partial<PairTurnInvokeContext> = {}): PairTurnInvokeContext {
    return {
      request: {
        pairGroupId: randomUUID(),
        companyId,
        round: 2,
        actorAgentId: agentId,
        role: "owner",
        previousTurnSummary: null,
      },
      promptText: "Round prompt body.",
      agent: { id: agentId, name: "Ada", role: "engineer", adapter: "claude_local" },
      issue: null,
      ...over,
    };
  }

  async function getRun(runId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return rows[0] ?? null;
  }

  it("creates a running heartbeat_runs row and hands its uuid to the JWT + single turn; exposes it on the in-flight registry", async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let signalTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      signalTurnStarted = resolve;
    });

    let seen: AdapterExecutionContext | null = null;
    const issueLocalAgentJwt = vi.fn(() => "pair-jwt-token");
    const invoke = buildRealPairTurnInvoke({
      db,
      issueLocalAgentJwt,
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          seen = c;
          signalTurnStarted();
          await turnGate;
          await c.onLog("stdout", "working…");
          return adapterResult({
            summary: "Did the thing.\nOUTCOME: delivered",
            costUsd: 0.42,
            billingType: "metered_api",
            model: "claude-opus-4-8",
          });
        }),
    });

    const issueId = randomUUID();
    const context = dbCtx({ issue: { id: issueId, title: "T", description: null } });
    // Drive through the registry like the route/ticker do, so the entry exists.
    expect(pairRunRegistry.tryAcquire(context.request.pairGroupId, "manual")).toBe(true);
    try {
      const pendingInvoke = invoke(context);
      await turnStarted;

      // While the turn is mid-flight: the run row exists and is "running".
      expect(seen).not.toBeNull();
      const runId = seen!.runId;
      expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const running = await getRun(runId);
      expect(running).not.toBeNull();
      expect(running!.status).toBe("running");
      expect(running!.startedAt).not.toBeNull();
      expect(running!.invocationSource).toBe("pair_round");
      expect(running!.contextSnapshot).toMatchObject({
        pairTurn: true,
        pairGroupId: context.request.pairGroupId,
        round: 2,
        role: "owner",
        issueId,
      });
      // The JWT carries the SAME uuid (this is what checkout_run_id receives).
      expect(issueLocalAgentJwt).toHaveBeenCalledWith(agentId, companyId, "claude_local", runId);
      // In-flight registry surfaces the executing run for the pair-group GET.
      expect(pairRunRegistry.get(context.request.pairGroupId)?.runId).toBe(runId);

      releaseTurn();
      const res = await pendingInvoke;
      expect(res.outcome).toBe("delivered");
      expect(res.metadata).toMatchObject({ runId });
      // Turn settled → registry runId cleared (entry itself is the driver's).
      expect(pairRunRegistry.get(context.request.pairGroupId)?.runId).toBeNull();
    } finally {
      pairRunRegistry.release(context.request.pairGroupId);
    }
  });

  it("finalizes the run as succeeded with finishedAt, usage and pair-turn result metadata", async () => {
    let seen: AdapterExecutionContext | null = null;
    const invoke = buildRealPairTurnInvoke({
      db,
      issueLocalAgentJwt: () => "jwt",
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          seen = c;
          await c.onLog("stdout", "step one\n");
          await c.onLog("stderr", "warn: something minor\n");
          return adapterResult({
            summary: "Refined the plan.\nOUTCOME: no_change",
            costUsd: 0.2,
            billingType: "metered_api",
            model: "claude-opus-4-8",
            provider: "anthropic",
          });
        }),
    });

    const res = await invoke(dbCtx({ request: { ...dbCtx().request, role: "counterpart" } }));
    expect(res.outcome).toBe("no_change");

    const run = await getRun(seen!.runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("succeeded");
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.exitCode).toBe(0);
    expect(run!.usageJson).toMatchObject({
      costUsd: 0.2,
      billingType: "metered_api",
      model: "claude-opus-4-8",
      provider: "anthropic",
    });
    expect(run!.resultJson).toMatchObject({
      summary: "Refined the plan.\nOUTCOME: no_change",
      pairTurn: { role: "counterpart", outcome: "no_change" },
    });
    expect(run!.stdoutExcerpt).toContain("step one");
    expect(run!.stderrExcerpt).toContain("something minor");
    expect(Number(run!.logBytes ?? 0)).toBeGreaterThan(0);
    expect(run!.lastOutputAt).not.toBeNull();
  });

  it("finalizes the run as failed on an adapter-level failure (non-zero exit)", async () => {
    let seen: AdapterExecutionContext | null = null;
    const invoke = buildRealPairTurnInvoke({
      db,
      issueLocalAgentJwt: () => "jwt",
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          seen = c;
          await c.onLog("stderr", "boom\n");
          return adapterResult({ exitCode: 2, costUsd: 0.05, billingType: "metered_api" });
        }),
    });

    const res = await invoke(dbCtx());
    expect(res.outcome).toBe("abort");

    const run = await getRun(seen!.runId);
    expect(run!.status).toBe("failed");
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.exitCode).toBe(2);
    expect(run!.error).toContain("exit code 2");
    expect(run!.errorCode).toBe("adapter_failed");
    expect(run!.resultJson).toMatchObject({ pairTurn: { outcome: "abort" } });
  });

  it("finalizes the run as failed when the adapter throws (finally path)", async () => {
    const issueLocalAgentJwt = vi.fn(() => "jwt");
    const invoke = buildRealPairTurnInvoke({
      db,
      issueLocalAgentJwt,
      resolveAdapter: () =>
        fakeAdapter(async () => {
          throw new Error("spawn ENOENT");
        }),
    });

    const res = await invoke(dbCtx());
    expect(res.outcome).toBe("abort");

    // Recover the runId from the JWT call (the adapter ctx never materialized).
    const runId = issueLocalAgentJwt.mock.calls[0]![3] as string;
    const run = await getRun(runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("failed");
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.error).toContain("spawn ENOENT");
    expect(run!.errorCode).toBe("adapter_error");
  });

  it("persists onLog chunks to the run log store and lifecycle events to heartbeat_run_events", async () => {
    let seen: AdapterExecutionContext | null = null;
    const invoke = buildRealPairTurnInvoke({
      db,
      issueLocalAgentJwt: () => "jwt",
      resolveAdapter: () =>
        fakeAdapter(async (c) => {
          seen = c;
          await c.onLog("stdout", '{"type":"system","subtype":"hook_started"}\n');
          await c.onLog("stdout", "assistant text chunk\n");
          return adapterResult({
            summary: "Done.\nOUTCOME: delivered",
            costUsd: 0,
            billingType: "subscription",
          });
        }),
    });

    await invoke(dbCtx());
    const run = await getRun(seen!.runId);
    expect(run!.logStore).toBe("local_file");
    expect(run!.logRef).toBeTruthy();

    // Chunks landed in the run log store (the GET /heartbeat-runs/:id/log path).
    const logRead = await getRunLogStore().read(
      { store: "local_file", logRef: run!.logRef! },
      { offset: 0, limitBytes: 256_000 },
    );
    expect(logRead.content).toContain("hook_started");
    expect(logRead.content).toContain("assistant text chunk");

    // Lifecycle events follow heartbeat's appendRunEvent convention.
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run!.id))
      .orderBy(asc(heartbeatRunEvents.seq));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      seq: 1,
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "pair turn started",
    });
    expect(events[1]).toMatchObject({
      seq: 2,
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "pair turn succeeded",
    });
    expect(events[1].payload).toMatchObject({ status: "succeeded", outcome: "delivered" });
  });
});
