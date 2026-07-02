import { describe, expect, it } from "vitest";
import {
  parseReviewVerdict,
  runAgentDeliberation,
  type DeliberationInvoke,
  type DeliberationTranscriptEntry,
} from "../services/agent-deliberation.ts";

// Dual-brain FUSION engine — hermetic tests.
//
// Pure stub `invoke`: NO embedded-pg, NO LLM, NO adapter. Each test drives the
// fusion with a deterministic queue of brain outputs (A generate, B generate,
// then the synthesizer) and asserts the final output, who synthesized, and the
// full transcript. The parseReviewVerdict convention (still used by the
// execution-layer pass) is exercised in its own block below.

// Build a stub invoke from an ordered list of raw brain outputs: index 0 = brain
// A's generated candidate, 1 = brain B's candidate, 2 = the synthesizer's merge.
// Records every call's args so adapter/model/candidate threading can be asserted.
function scriptedInvoke(script: string[]): {
  invoke: DeliberationInvoke;
  calls: Array<Parameters<DeliberationInvoke>[0]>;
} {
  const calls: Array<Parameters<DeliberationInvoke>[0]> = [];
  let i = 0;
  const invoke: DeliberationInvoke = async (args) => {
    calls.push(args);
    const out = script[i] ?? `out-${i}`;
    i += 1;
    return out;
  };
  return { invoke, calls };
}

describe("runAgentDeliberation (Fusion: parallel generate + synthesize)", () => {
  it("(a) generates two candidates in parallel, then the synthesizer merges them", async () => {
    const { invoke, calls } = scriptedInvoke([
      "candidate-A", // brain A generates
      "candidate-B", // brain B generates
      "merged-final", // synthesizer (A) merges both
    ]);

    const result = await runAgentDeliberation({
      task: "Summarize the design.",
      // WC-208: each brain carries its OWN adapter alongside its model (here a
      // cross-adapter config: brain A = claude_local, brain B = codex_local).
      brainA: { adapter: "claude_local", model: "model-a" },
      brainB: { adapter: "codex_local", model: "model-b" },
      maxRounds: 4, // legacy field, ignored by fusion
      invoke,
    });

    expect(result.finalOutput).toBe("merged-final");
    expect(result.acceptedBy).toBe("A"); // the synthesizer brain
    expect(result.rounds).toBe(1);

    expect(result.transcript).toEqual([
      { round: 0, brain: "A", action: "generate", content: "candidate-A", feedback: null },
      { round: 0, brain: "B", action: "generate", content: "candidate-B", feedback: null },
      { round: 1, brain: "A", action: "synthesize", content: "merged-final", feedback: null },
    ]);

    // Call order: A generate, B generate (parallel, stable A→B), then A synthesize.
    expect(calls.map((c) => `${c.brain}:${c.role}:${c.round}`)).toEqual([
      "A:generate:0",
      "B:generate:0",
      "A:synthesize:1",
    ]);
    // Generate turns carry no candidates; the synthesize turn gets BOTH, and each
    // turn runs the synthesizer/brain's own adapter + model.
    expect(calls[0]).toMatchObject({ adapter: "claude_local", model: "model-a", candidates: [] });
    expect(calls[1]).toMatchObject({ adapter: "codex_local", model: "model-b", candidates: [] });
    expect(calls[2]).toMatchObject({
      brain: "A",
      adapter: "claude_local",
      model: "model-a",
      candidates: ["candidate-A", "candidate-B"],
    });
  });

  it("(b) uses brain B as the synthesizer when configured", async () => {
    const { invoke, calls } = scriptedInvoke(["a", "b", "final-by-b"]);

    const result = await runAgentDeliberation({
      task: "Pick a name.",
      brainA: { model: "a" },
      brainB: { model: "b" },
      synthesizer: "B",
      invoke,
    });

    expect(result.finalOutput).toBe("final-by-b");
    expect(result.acceptedBy).toBe("B");
    expect(result.transcript[2]).toEqual({
      round: 1,
      brain: "B",
      action: "synthesize",
      content: "final-by-b",
      feedback: null,
    });
    expect(calls[2]).toMatchObject({ brain: "B", role: "synthesize", candidates: ["a", "b"] });
  });

  it("(c) threads adapter:null for a brain with no adapter override (inherit)", async () => {
    const { invoke, calls } = scriptedInvoke(["a", "b", "f"]);

    await runAgentDeliberation({
      task: "Inherit the adapter.",
      brainA: { adapter: "codex_local", model: null },
      brainB: { model: null }, // no adapter → inherit
      invoke,
    });

    expect(calls[0]).toMatchObject({ brain: "A", role: "generate", adapter: "codex_local", model: null });
    expect(calls[1]).toMatchObject({ brain: "B", role: "generate", adapter: null, model: null });
  });

  it("(d) fires onTurn once per transcript entry, in order, awaited", async () => {
    const { invoke } = scriptedInvoke(["a", "b", "f"]);

    const seen: DeliberationTranscriptEntry[] = [];
    const result = await runAgentDeliberation({
      task: "Persist each turn.",
      brainA: { model: "a" },
      brainB: { model: "b" },
      invoke,
      onTurn: async (entry) => {
        // Yield a microtask to prove the engine awaits the callback before the
        // next entry is produced.
        await Promise.resolve();
        seen.push(entry);
      },
    });

    expect(seen).toHaveLength(result.transcript.length);
    expect(seen).toEqual(result.transcript);
    expect(seen).toEqual([
      { round: 0, brain: "A", action: "generate", content: "a", feedback: null },
      { round: 0, brain: "B", action: "generate", content: "b", feedback: null },
      { round: 1, brain: "A", action: "synthesize", content: "f", feedback: null },
    ]);
  });
});

describe("parseReviewVerdict — 5-section structured verdict (execution-layer pass)", () => {
  it("parses a structured ACCEPT with confidence + sections", () => {
    const v = parseReviewVerdict(
      JSON.stringify({
        verdict: "accept",
        confidence: 0.92,
        consensus: ["auth flow is correct", "  "],
        blindSpots: [],
        summary: "Looks good",
      }),
    );
    expect(v.verdict).toBe("accept");
    if (v.verdict !== "accept") throw new Error("expected accept");
    expect(v.confidence).toBe(0.92);
    expect(v.summary).toBe("Looks good");
    expect(v.sections?.consensus).toEqual(["auth flow is correct"]); // blank dropped
    expect(v.requiredChanges).toEqual([]);
  });

  it("parses a structured REVISE: requiredChanges drive feedback + sections kept", () => {
    const v = parseReviewVerdict(
      JSON.stringify({
        verdict: "revise",
        confidence: 0.4,
        contradictions: ["returns 200 on an invalid token"],
        blindSpots: ["no test for the expiry path"],
        requiredChanges: ["Reject expired tokens with 401", "Add an expiry unit test"],
        summary: "Auth gap",
      }),
    );
    expect(v.verdict).toBe("revise");
    if (v.verdict !== "revise") throw new Error("expected revise");
    expect(v.confidence).toBe(0.4);
    expect(v.requiredChanges).toEqual(["Reject expired tokens with 401", "Add an expiry unit test"]);
    // feedback is stitched from requiredChanges when no explicit feedback given.
    expect(v.feedback).toContain("1. Reject expired tokens with 401");
    expect(v.feedback).toContain("2. Add an expiry unit test");
    expect(v.sections?.contradictions).toEqual(["returns 200 on an invalid token"]);
    expect(v.sections?.blindSpots).toEqual(["no test for the expiry path"]);
  });

  it("keeps the legacy {verdict:revise, revision, feedback} shape working", () => {
    const v = parseReviewVerdict(JSON.stringify({ verdict: "revise", revision: "v2 text", feedback: "do x" }));
    expect(v.verdict).toBe("revise");
    if (v.verdict !== "revise") throw new Error("expected revise");
    expect(v.revision).toBe("v2 text");
    expect(v.feedback).toBe("do x");
    expect(v.requiredChanges).toEqual([]);
    expect(v.sections).toBeNull();
  });

  it("clamps an out-of-range confidence and omits empty sections", () => {
    const accepted = parseReviewVerdict(JSON.stringify({ verdict: "accept", confidence: 5 }));
    expect(accepted.verdict === "accept" && accepted.confidence).toBe(1);
    const terse = parseReviewVerdict(JSON.stringify({ verdict: "accept" }));
    expect(terse.verdict === "accept" && terse.sections).toBeNull();
    expect(terse.verdict === "accept" && terse.confidence).toBeNull();
  });

  it("falls back to revise-with-raw-text on unparseable/prose output (local healing)", () => {
    const v = parseReviewVerdict("the work looks mostly fine but check edge cases");
    expect(v.verdict).toBe("revise");
    if (v.verdict !== "revise") throw new Error("expected revise");
    expect(v.revision).toBe("the work looks mostly fine but check edge cases");
    expect(v.requiredChanges).toEqual([]);
    expect(v.sections).toBeNull();
    expect(v.confidence).toBeNull();
  });
});
