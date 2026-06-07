import { describe, expect, it } from "vitest";
import {
  runAgentDeliberation,
  type DeliberationInvoke,
  type DeliberationTranscriptEntry,
} from "../services/agent-deliberation.ts";

// WC-204 (deliberation mode, slice 1) — hermetic engine tests.
//
// Pure stub `invoke`: NO embedded-pg, NO LLM, NO adapter. Each test drives the
// loop with a deterministic queue of brain outputs and asserts the converged
// output, who accepted, the round count, and the full transcript. The verdict
// convention is exercised directly (accept / revise JSON) plus the defensive
// fallback (plain prose → treated as a revise).

const accept = JSON.stringify({ verdict: "accept" });
const revise = (revision: string, feedback?: string): string =>
  JSON.stringify(feedback ? { verdict: "revise", revision, feedback } : { verdict: "revise", revision });

// Build a stub invoke from an ordered list of raw brain outputs (one per turn,
// propose first). Records every call's args so threading can be asserted.
function scriptedInvoke(script: string[]): {
  invoke: DeliberationInvoke;
  calls: Array<Parameters<DeliberationInvoke>[0]>;
} {
  const calls: Array<Parameters<DeliberationInvoke>[0]> = [];
  let i = 0;
  const invoke: DeliberationInvoke = async (args) => {
    calls.push(args);
    const out = script[i] ?? accept; // default to accept if the script runs dry
    i += 1;
    return out;
  };
  return { invoke, calls };
}

describe("WC-204 runAgentDeliberation", () => {
  it("(a) converges when a brain accepts (A v0 → B revise v1 → A revise v2 → B accept)", async () => {
    const { invoke, calls } = scriptedInvoke([
      "v0", // round 0: A proposes
      revise("v1", "tighten the intro"), // round 1: B revises
      revise("v2", "fix the edge case"), // round 2: A revises
      accept, // round 3: B accepts v2
    ]);

    const result = await runAgentDeliberation({
      task: "Summarize the design.",
      // WC-208: each brain carries its OWN adapter alongside its model — here a
      // cross-adapter config (brain A = claude_local, brain B = codex_local).
      brainA: { adapter: "claude_local", model: "model-a" },
      brainB: { adapter: "codex_local", model: "model-b" },
      maxRounds: 4,
      invoke,
    });

    expect(result.finalOutput).toBe("v2");
    expect(result.acceptedBy).toBe("B");
    expect(result.rounds).toBe(3);

    expect(result.transcript).toEqual([
      { round: 0, brain: "A", action: "propose", content: "v0", feedback: null },
      { round: 1, brain: "B", action: "revise", content: "v1", feedback: "tighten the intro" },
      { round: 2, brain: "A", action: "revise", content: "v2", feedback: "fix the edge case" },
      { round: 3, brain: "B", action: "accept", content: "v2", feedback: null },
    ]);

    // Brains alternate starting with B, run their OWN (possibly different)
    // adapter + model, and each review sees the latest proposal.
    expect(calls.map((c) => `${c.brain}:${c.role}:${c.round}`)).toEqual([
      "A:propose:0",
      "B:review:1",
      "A:review:2",
      "B:review:3",
    ]);
    // WC-208: the per-brain adapter is threaded into EVERY invoke call for that
    // brain (A → claude_local, B → codex_local), alongside the per-brain model.
    expect(calls[0]).toMatchObject({ adapter: "claude_local", model: "model-a", currentProposal: null });
    expect(calls[1]).toMatchObject({ adapter: "codex_local", model: "model-b", currentProposal: "v0" });
    expect(calls[2]).toMatchObject({ adapter: "claude_local", model: "model-a", currentProposal: "v1" });
    expect(calls[3]).toMatchObject({ adapter: "codex_local", model: "model-b", currentProposal: "v2" });
  });

  it("(b) stops immediately when B accepts A's first draft", async () => {
    const { invoke, calls } = scriptedInvoke([
      "draft-0", // A proposes
      accept, // B accepts straight away
    ]);

    const result = await runAgentDeliberation({
      task: "Pick a name.",
      brainA: { model: "a" },
      brainB: { model: "b" },
      maxRounds: 4,
      invoke,
    });

    expect(result.finalOutput).toBe("draft-0");
    expect(result.acceptedBy).toBe("B");
    expect(result.rounds).toBe(1);
    expect(result.transcript).toEqual([
      { round: 0, brain: "A", action: "propose", content: "draft-0", feedback: null },
      { round: 1, brain: "B", action: "accept", content: "draft-0", feedback: null },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("(c) hits the maxRounds cap when both brains always revise (no accept)", async () => {
    const { invoke, calls } = scriptedInvoke([
      "p0", // A proposes
      revise("p1"), // round 1: B
      revise("p2"), // round 2: A
      revise("p3"), // round 3: B
      revise("p4"), // round 4: A
      // round 5 would exceed maxRounds=4 → loop stops, latest proposal wins
    ]);

    const result = await runAgentDeliberation({
      task: "Argue forever.",
      brainA: { model: "a" },
      brainB: { model: "b" },
      maxRounds: 4,
      invoke,
    });

    expect(result.acceptedBy).toBeNull();
    expect(result.finalOutput).toBe("p4");
    expect(result.rounds).toBe(4);
    // 1 propose + exactly maxRounds reviews, never more.
    expect(calls).toHaveLength(5);
    expect(result.transcript).toEqual([
      { round: 0, brain: "A", action: "propose", content: "p0", feedback: null },
      { round: 1, brain: "B", action: "revise", content: "p1", feedback: null },
      { round: 2, brain: "A", action: "revise", content: "p2", feedback: null },
      { round: 3, brain: "B", action: "revise", content: "p3", feedback: null },
      { round: 4, brain: "A", action: "revise", content: "p4", feedback: null },
    ]);
  });

  it("(d) treats an unparseable plain-prose review as a revise without crashing", async () => {
    const prose = "Honestly I think this needs more detail in the second section.";
    const { invoke } = scriptedInvoke([
      "draft", // A proposes
      prose, // round 1: B returns plain prose (no JSON) → defensive revise
      accept, // round 2: A accepts the prose-as-proposal
    ]);

    const result = await runAgentDeliberation({
      task: "Edge case.",
      brainA: { model: "a" },
      brainB: { model: "b" },
      maxRounds: 4,
      invoke,
    });

    // The prose became the new proposal; the loop continued and terminated.
    expect(result.finalOutput).toBe(prose);
    expect(result.acceptedBy).toBe("A");
    expect(result.rounds).toBe(2);
    expect(result.transcript).toEqual([
      { round: 0, brain: "A", action: "propose", content: "draft", feedback: null },
      { round: 1, brain: "B", action: "revise", content: prose, feedback: null },
      { round: 2, brain: "A", action: "accept", content: prose, feedback: null },
    ]);
  });

  it("(d2) reads the verdict from a JSON object embedded in surrounding prose", async () => {
    // Defensive parse must find the FIRST balanced JSON object even when the
    // model wraps it in chatter — not rely on the whole output being pure JSON.
    const embedded = `Sure, here's my call:\n${revise("improved", "added examples")}\nHope that helps!`;
    const { invoke } = scriptedInvoke([
      "base", // A proposes
      embedded, // round 1: B revises via embedded JSON
      accept, // round 2: A accepts
    ]);

    const result = await runAgentDeliberation({
      task: "Embedded JSON.",
      brainA: { model: "a" },
      brainB: { model: "b" },
      maxRounds: 4,
      invoke,
    });

    expect(result.finalOutput).toBe("improved");
    expect(result.acceptedBy).toBe("A");
    expect(result.transcript[1]).toEqual({
      round: 1,
      brain: "B",
      action: "revise",
      content: "improved",
      feedback: "added examples",
    });
  });

  it("(f) fires onTurn once per transcript entry, in order, awaited", async () => {
    // WC-209: the optional onTurn hook must fire exactly once per pushed
    // transcript entry (propose + each accept/revise), in the same order, with
    // the same entry object — and the engine must AWAIT it (so a persistence
    // write lands before the next turn). We assert the awaited contract by
    // resolving each onTurn on a microtask and checking the seen list matches
    // the final transcript 1:1.
    const { invoke } = scriptedInvoke([
      "v0", // round 0: A proposes
      revise("v1", "tighten"), // round 1: B revises
      accept, // round 2: A accepts v1
    ]);

    const seen: DeliberationTranscriptEntry[] = [];
    const result = await runAgentDeliberation({
      task: "Persist each turn.",
      brainA: { model: "a" },
      brainB: { model: "b" },
      maxRounds: 4,
      invoke,
      onTurn: async (entry) => {
        // Yield a microtask to prove the engine awaits the callback before
        // producing the next entry (otherwise ordering could interleave).
        await Promise.resolve();
        seen.push(entry);
      },
    });

    // Exactly one onTurn per entry, same order, same content as the transcript.
    expect(seen).toHaveLength(result.transcript.length);
    expect(seen).toEqual(result.transcript);
    expect(seen).toEqual([
      { round: 0, brain: "A", action: "propose", content: "v0", feedback: null },
      { round: 1, brain: "B", action: "revise", content: "v1", feedback: "tighten" },
      { round: 2, brain: "A", action: "accept", content: "v1", feedback: null },
    ]);
  });

  it("(e) threads adapter:null for a brain with no adapter override (inherit)", async () => {
    // WC-208: when a brain omits `adapter`, the engine passes `adapter: null` so
    // the live invoke falls back to the agent's own adapterType. Brain A here
    // pins an adapter; brain B inherits.
    const { invoke, calls } = scriptedInvoke(["draft", accept]);

    await runAgentDeliberation({
      task: "Inherit the adapter.",
      brainA: { adapter: "codex_local", model: null },
      brainB: { model: null }, // no adapter → inherit
      maxRounds: 4,
      invoke,
    });

    expect(calls[0]).toMatchObject({ brain: "A", adapter: "codex_local", model: null });
    expect(calls[1]).toMatchObject({ brain: "B", adapter: null, model: null });
  });
});
