import { describe, expect, it, vi } from "vitest";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "../adapters/index.js";
import { buildRealPairTurnInvoke } from "../services/pair-turn-real-invoke.ts";
import { stubPairTurnInvoke } from "../services/pair-turn-executors.ts";
import type {
  PairTurnInvokeContext,
} from "../services/pair-turn-executors.ts";
import type { SingleTurnAdapter } from "../services/adapter-single-turn.ts";

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
