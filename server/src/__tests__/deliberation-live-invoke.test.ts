import { describe, expect, it } from "vitest";
import { buildLiveDeliberationInvoke } from "../services/deliberation-live-invoke.ts";

// WC-207 (smoke-test fix): the live DeliberationInvoke must return the adapter's
// parsed assistant TEXT (result.summary), NOT the raw stdout. For stream-json
// adapters (claude-local) stdout is the NDJSON protocol stream — returning it
// made each brain "see" protocol garbage and made the engine's verdict parser
// grab the first system-hook JSON instead of the model's {"verdict":...}. These
// tests drive the live factory with a FAKE adapter (the resolveAdapter seam) so
// no real CLI/LLM runs.

const agent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Planner",
  adapterType: "claude_local",
  adapterConfig: {},
};

// A fake adapter that streams `rawStdout` (the NDJSON protocol) to onLog but
// returns `summary` as the parsed assistant text — exactly claude-local's shape.
function fakeAdapter(summary: string | null, rawStdout: string) {
  return {
    execute: async (ctx: { onLog?: (s: string, c: string) => Promise<void> | void }) => {
      if (ctx.onLog) await ctx.onLog("stdout", rawStdout);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary,
        costUsd: 0.012,
        billingType: "usage",
      } as never;
    },
  };
}

describe("WC-207 buildLiveDeliberationInvoke — clean text extraction", () => {
  it("returns the parsed assistant summary, NOT the raw stream-json stdout", async () => {
    const cleanVerdict = '{"verdict":"accept"}';
    // claude-local-style stream: a system hook JSON FIRST (the bug-bait), then
    // the result event carrying the clean text.
    const rawStream =
      '{"type":"system","subtype":"hook_started","hook_name":"SessionStart"} ' +
      `{"type":"result","subtype":"success","result":${JSON.stringify(cleanVerdict)}}`;
    const invoke = buildLiveDeliberationInvoke({
      agent,
      runIdBase: "delib-test",
      resolveAdapter: () => fakeAdapter(cleanVerdict, rawStream),
    });

    const out = await invoke({
      brain: "B",
      role: "review",
      model: null,
      task: "design the idle-reward screen",
      currentProposal: "draft",
      round: 1,
    });

    expect(out).toBe(cleanVerdict);
    expect(out).not.toContain("hook_started"); // no protocol garbage leaked
  });

  it("falls back to empty string when the adapter returns no summary", async () => {
    const invoke = buildLiveDeliberationInvoke({
      agent,
      runIdBase: "delib-test",
      resolveAdapter: () => fakeAdapter(null, "noise on stdout"),
    });
    const out = await invoke({
      brain: "A",
      role: "propose",
      model: null,
      task: "t",
      currentProposal: null,
      round: 0,
    });
    expect(out).toBe("");
  });

  it("reports the turn's billed cost via onCost", async () => {
    let reported = -1;
    const invoke = buildLiveDeliberationInvoke({
      agent,
      runIdBase: "delib-test",
      onCost: (c) => {
        reported = c;
      },
      resolveAdapter: () => fakeAdapter("ok", "raw"),
    });
    await invoke({
      brain: "A",
      role: "propose",
      adapter: null,
      model: null,
      task: "t",
      currentProposal: null,
      round: 0,
    });
    expect(reported).toBeGreaterThanOrEqual(0);
  });

  // WC-208 (per-brain adapter): the per-turn `adapter` arg the engine threads in
  // selects the adapter type for THIS brain's turn. The resolveAdapter seam is
  // the observable boundary — it receives the type runAdapterSingleTurn resolves.
  it("honors a per-brain adapter override (resolveAdapter receives the brain's adapter type)", async () => {
    const resolvedTypes: string[] = [];
    // agent.adapterType is claude_local, but brain B overrides to codex_local —
    // the override must win for this turn.
    const invoke = buildLiveDeliberationInvoke({
      agent,
      runIdBase: "delib-test",
      resolveAdapter: (type) => {
        resolvedTypes.push(type);
        return fakeAdapter('{"verdict":"accept"}', "raw");
      },
    });

    await invoke({
      brain: "B",
      role: "review",
      adapter: "codex_local",
      model: null,
      task: "t",
      currentProposal: "draft",
      round: 1,
    });

    expect(resolvedTypes).toEqual(["codex_local"]);
  });

  it("falls back to the agent's adapterType when a brain has no adapter override (null)", async () => {
    const resolvedTypes: string[] = [];
    const invoke = buildLiveDeliberationInvoke({
      agent, // adapterType: "claude_local"
      runIdBase: "delib-test",
      resolveAdapter: (type) => {
        resolvedTypes.push(type);
        return fakeAdapter("ok", "raw");
      },
    });

    await invoke({
      brain: "A",
      role: "propose",
      adapter: null,
      model: null,
      task: "t",
      currentProposal: null,
      round: 0,
    });

    expect(resolvedTypes).toEqual(["claude_local"]);
  });

  // WC-211 (finding 1 — resilience): each brain turn is bounded so a slow/hung
  // brain (codex_local was observed hanging 5+ min in local testing) can't stall
  // a run forever. Two mechanisms, two tests:
  //   (1) the JS-level Promise.race backstop, for an adapter whose promise never
  //       settles (it ignores its own timeoutSec) → the invoke rejects.
  //   (2) the adapter-knob conversion: an adapter that honored config.timeoutSec
  //       returns timedOut=true (no throw) → the invoke converts it to a throw.
  // A thrown timeout propagates to runAgentDeliberation's caller (the run
  // service), which marks the run status='failed'.

  // An adapter whose execute() never resolves — models a wedged CLI turn.
  function hangingAdapter() {
    return {
      execute: () => new Promise<never>(() => {}),
    };
  }

  it("(finding 1) rejects with a clear timeout error when the adapter hangs (Promise.race backstop)", async () => {
    const invoke = buildLiveDeliberationInvoke({
      agent,
      runIdBase: "delib-test",
      // Tiny per-turn timeout so the test resolves fast without fake timers.
      turnTimeoutMs: 20,
      resolveAdapter: () => hangingAdapter(),
    });

    await expect(
      invoke({
        brain: "A",
        role: "propose",
        adapter: null,
        model: null,
        task: "hang forever",
        currentProposal: null,
        round: 0,
      }),
    ).rejects.toThrow(/brain A turn timed out after/);
  });

  it("(finding 1) converts an adapter timedOut=true result into a thrown timeout error", async () => {
    // An adapter that honored its own timeoutSec: it returns (does not throw) a
    // result with timedOut:true and an empty summary. Without the conversion the
    // engine would treat "" as a revise and silently advance the loop.
    const timedOutAdapter = {
      execute: async () =>
        ({
          exitCode: null,
          signal: null,
          timedOut: true,
          summary: "",
          errorMessage: "Timed out after 120s",
        }) as never,
    };
    const invoke = buildLiveDeliberationInvoke({
      agent,
      runIdBase: "delib-test",
      resolveAdapter: () => timedOutAdapter,
    });

    await expect(
      invoke({
        brain: "B",
        role: "review",
        adapter: "codex_local",
        model: null,
        task: "t",
        currentProposal: "draft",
        round: 1,
      }),
    ).rejects.toThrow(/brain B turn timed out after/);
  });

  it("(finding 1) passes config.timeoutSec to the adapter so it can kill the CLI process", async () => {
    let seenTimeoutSec: unknown;
    const invoke = buildLiveDeliberationInvoke({
      agent,
      runIdBase: "delib-test",
      turnTimeoutMs: 120_000,
      resolveAdapter: () => ({
        execute: async (ctx: { config?: Record<string, unknown> }) => {
          seenTimeoutSec = ctx.config?.timeoutSec;
          return { exitCode: 0, signal: null, timedOut: false, summary: "ok" } as never;
        },
      }),
    });

    await invoke({
      brain: "A",
      role: "propose",
      adapter: null,
      model: null,
      task: "t",
      currentProposal: null,
      round: 0,
    });

    expect(seenTimeoutSec).toBe(120);
  });
});
