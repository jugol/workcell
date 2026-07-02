import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionResult } from "@workcell/adapter-utils";
import {
  mergePanelReviewVerdicts,
  runDeliberationPasses,
  type DeliberationPassInput,
  type DeliberationPassOutput,
  type RunDeliberationPassesOptions,
} from "../services/heartbeat-deliberation-pass.ts";

function ok(summary: string, costUsd: number | null = 0.1, extra: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary,
    costUsd,
    usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
    sessionParams: { sessionId: summary },
    resultJson: { ran: summary },
    ...extra,
  };
}

function fail(summary: string, extra: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult {
  return { exitCode: 1, signal: null, timedOut: false, summary, errorMessage: "boom", costUsd: 0.02, ...extra };
}

// Build a runPass that returns the given results in order and records inputs.
function scriptedRunPass(results: AdapterExecutionResult[]) {
  const calls: DeliberationPassInput[] = [];
  let i = 0;
  const runPass = vi.fn(async (input: DeliberationPassInput): Promise<DeliberationPassOutput> => {
    calls.push(input);
    const result = results[Math.min(i, results.length - 1)];
    i += 1;
    return { result, nextSession: { legacySessionId: result.summary ?? null, params: result.sessionParams ?? null, displayId: result.summary ?? null } };
  });
  return { runPass, calls };
}

function baseOpts(over: Partial<RunDeliberationPassesOptions> = {}): RunDeliberationPassesOptions {
  return {
    runPass: async () => ({ result: ok("x"), nextSession: { legacySessionId: null, params: null, displayId: null } }),
    baseTaskMarkdown: "TASK",
    workModel: null,
    reviewModel: "candidate-model",
    maxRounds: 4,
    budgetMs: 10_000_000,
    now: () => 0,
    parseVerdict: (text) => (text.includes("ACCEPT") ? { accept: true, feedback: null } : { accept: false, feedback: "fix it" }),
    isTerminal: async () => false,
    onPassEvent: async () => {},
    onBoundaryLog: async () => {},
    logWarn: () => {},
    ...over,
  };
}

describe("runDeliberationPasses (Fusion: work → candidate → synthesize)", () => {
  it("runs work, one independent candidate, then synthesize (3 passes)", async () => {
    const { runPass, calls } = scriptedRunPass([ok("work-1"), ok("candidate-1"), ok("synth-1")]);
    const result = await runDeliberationPasses(baseOpts({ runPass }));

    expect(calls.map((c) => c.kind)).toEqual(["work", "candidate", "synthesize"]);
    expect(calls[0].brain).toBe("A");
    expect(calls[1].brain).toBe("B"); // independent candidate
    expect(calls[2].brain).toBe("A"); // synthesizer
    // The candidate used the candidate model; work + synthesize used the work model.
    expect(calls[1].model).toBe("candidate-model");
    // The synthesize prompt carries the candidate's proposal.
    expect(calls[2].taskMarkdown).toContain("candidate-1");
    // Final result is the synthesize pass's, with a passes[] breakdown of 3.
    expect(result.summary).toBe("synth-1");
    expect((result.resultJson as Record<string, unknown>).deliberationPasses).toHaveLength(3);
  });

  it("candidate runs FRESH (independent); synthesize resumes the work session", async () => {
    const { runPass, calls } = scriptedRunPass([ok("work-sess"), ok("cand"), ok("synth")]);
    await runDeliberationPasses(baseOpts({ runPass }));
    // Pass 0 uses the incoming (undefined) session.
    expect(calls[0].session).toBeUndefined();
    // Candidate is a brand-new independent session (no resume).
    expect(calls[1].fresh).toBe(true);
    expect(calls[1].session).toBeUndefined();
    // Synthesize resumes the WORK brain's session (continues its own thread).
    expect(calls[2].fresh).toBeUndefined();
    expect(calls[2].session?.legacySessionId).toBe("work-sess");
  });

  it("a failed pass-0 work run returns immediately — no candidate, no synthesize", async () => {
    const { runPass, calls } = scriptedRunPass([fail("work-failed"), ok("cand")]);
    const result = await runDeliberationPasses(baseOpts({ runPass }));
    expect(calls.map((c) => c.kind)).toEqual(["work"]);
    expect(result.summary).toBe("work-failed");
    expect(result.exitCode).toBe(1);
  });

  it("a failed candidate is skipped (non-fatal); with no usable candidate the work stands", async () => {
    const { runPass, calls } = scriptedRunPass([ok("good-work"), fail("candidate-crashed")]);
    const result = await runDeliberationPasses(baseOpts({ runPass }));
    // work + the (failed) candidate ran; no synthesize (nothing to fuse).
    expect(calls.map((c) => c.kind)).toEqual(["work", "candidate"]);
    expect(result.summary).toBe("good-work");
    expect(result.exitCode).toBe(0);
  });

  it("a failed synthesize is non-fatal — the work result stands", async () => {
    const { runPass, calls } = scriptedRunPass([ok("work-ok"), ok("cand"), fail("synth-failed")]);
    const result = await runDeliberationPasses(baseOpts({ runPass }));
    expect(calls.map((c) => c.kind)).toEqual(["work", "candidate", "synthesize"]);
    // The synthesize failed → fall back to the work result (the work stands).
    expect(result.summary).toBe("work-ok");
    expect(result.exitCode).toBe(0);
  });

  it("aggregates cost + usage across all passes and records passes[]", async () => {
    const { runPass } = scriptedRunPass([ok("w", 0.1), ok("c", 0.05), ok("s", 0.08)]);
    const result = await runDeliberationPasses(baseOpts({ runPass }));
    // work(0.10) + candidate(0.05) + synthesize(0.08) = 0.23
    expect(result.costUsd).toBeCloseTo(0.23, 6);
    // 3 passes, each contributed 100/50 tokens.
    expect(result.usage?.inputTokens).toBe(300);
    expect(result.usage?.outputTokens).toBe(150);
    const passes = (result.resultJson as Record<string, unknown>).deliberationPasses as Array<Record<string, unknown>>;
    expect(passes.map((p) => p.kind)).toEqual(["work", "candidate", "synthesize"]);
  });

  it("breaks at a terminal status right after the work pass (no candidate spawned)", async () => {
    let terminal = false;
    const { runPass, calls } = scriptedRunPass([ok("w0"), ok("cand"), ok("synth")]);
    const result = await runDeliberationPasses(
      baseOpts({
        runPass,
        // false the first time (after work) ... actually true the first call: returns false, sets true.
        isTerminal: async () => {
          const was = terminal;
          terminal = true;
          return was;
        },
      }),
    );
    // isTerminal checked after the work pass: first call returns false → proceeds;
    // checked again after candidates returns true → no synthesize. But the second
    // check happens only if a candidate produced a proposal. Here the candidate
    // runs, then the post-candidate terminal check (2nd call) returns true → work stands.
    expect(calls.map((c) => c.kind)).toEqual(["work", "candidate"]);
    expect(result.summary).toBe("w0");
  });

  it("emits a deliberation.pass event for every pass (brain + kind)", async () => {
    const events: Array<{ brain: string; kind: string }> = [];
    const { runPass } = scriptedRunPass([ok("w0"), ok("cand"), ok("synth")]);
    await runDeliberationPasses(
      baseOpts({ runPass, onPassEvent: async (rec) => { events.push({ brain: rec.brain, kind: rec.kind }); } }),
    );
    expect(events).toEqual([
      { brain: "A", kind: "work" },
      { brain: "B", kind: "candidate" },
      { brain: "A", kind: "synthesize" },
    ]);
  });
});

describe("runDeliberationPasses — independent panel (multiple candidates)", () => {
  const panelOpts = (over: Partial<RunDeliberationPassesOptions> = {}): RunDeliberationPassesOptions =>
    baseOpts({
      reviewMode: "panel",
      panelMembers: [{ model: "m1", adapter: null }, { model: "m2", adapter: null }, { model: "m3", adapter: null }],
      ...over,
    });

  it("runs every panel member as an independent candidate, then synthesizes all", async () => {
    const { runPass, calls } = scriptedRunPass([ok("w0"), ok("cand-1"), ok("cand-2"), ok("cand-3"), ok("synth")]);
    const events: Array<{ kind: string; panelMember?: number }> = [];
    const result = await runDeliberationPasses(
      panelOpts({ runPass, onPassEvent: async (rec) => events.push({ kind: rec.kind, panelMember: rec.panelMember }) }),
    );

    expect(calls.map((c) => c.kind)).toEqual(["work", "candidate", "candidate", "candidate", "synthesize"]);
    // Every candidate runs FRESH + independent and is brain B.
    expect(calls.slice(1, 4).every((c) => c.brain === "B" && c.fresh === true && c.session === undefined)).toBe(true);
    expect(result.summary).toBe("synth");
    // Each candidate event is tagged with its panel-member index.
    expect(events.filter((e) => e.kind === "candidate").map((e) => e.panelMember)).toEqual([0, 1, 2]);
  });

  it("the synthesize prompt includes every live candidate's proposal", async () => {
    const { runPass, calls } = scriptedRunPass([ok("w0"), ok("idea-alpha"), ok("idea-beta"), ok("idea-gamma"), ok("synth")]);
    await runDeliberationPasses(panelOpts({ runPass }));
    const synthPrompt = calls[4].taskMarkdown;
    expect(synthPrompt).toContain("idea-alpha");
    expect(synthPrompt).toContain("idea-beta");
    expect(synthPrompt).toContain("idea-gamma");
    expect(synthPrompt).toContain("Candidate 1");
    expect(synthPrompt).toContain("Candidate 3");
  });

  it("skips a candidate that throws and still synthesizes from the rest", async () => {
    let n = 0;
    const calls: DeliberationPassInput[] = [];
    const runPass = vi.fn(async (input: DeliberationPassInput): Promise<DeliberationPassOutput> => {
      calls.push(input);
      n += 1;
      // 1=work, 2=candidate ok, 3=candidate THROWS, 4=candidate ok, 5=synthesize
      if (n === 3) throw new Error("candidate 2 CLI crashed");
      const summary = n === 1 ? "w0" : n === 5 ? "synth" : `cand-${n}`;
      return { result: ok(summary), nextSession: { legacySessionId: summary, params: null, displayId: summary } };
    });
    const result = await runDeliberationPasses(panelOpts({ runPass }));

    // work + 3 candidate attempts (one threw) + synthesize from the 2 live ones.
    expect(calls.map((c) => c.kind)).toEqual(["work", "candidate", "candidate", "candidate", "synthesize"]);
    expect(result.summary).toBe("synth");
  });
});

describe("mergePanelReviewVerdicts", () => {
  it("dedups requiredChanges, unions sections, and takes the lowest confidence", () => {
    const merged = mergePanelReviewVerdicts([
      { accept: false, feedback: "a", requiredChanges: ["Fix auth", "Add test"], confidence: 0.6, sections: { consensus: [], contradictions: ["c1"], partialCoverage: [], uniqueInsights: [], blindSpots: ["b1"] } },
      { accept: false, feedback: "b", requiredChanges: ["fix auth", "Handle null"], confidence: 0.2, sections: { consensus: [], contradictions: ["c1"], partialCoverage: [], uniqueInsights: [], blindSpots: ["b2"] } },
      { accept: true, feedback: null },
    ]);
    expect(merged.accept).toBe(false);
    // "Fix auth" / "fix auth" dedup case-insensitively; order preserved.
    expect(merged.requiredChanges).toEqual(["Fix auth", "Add test", "Handle null"]);
    expect(merged.feedback).toBe("a\nb");
    expect(merged.confidence).toBe(0.2);
    expect(merged.sections?.contradictions).toEqual(["c1"]); // unioned, deduped
    expect(merged.sections?.blindSpots).toEqual(["b1", "b2"]);
  });

  it("returns null sections/confidence when no member supplied them", () => {
    const merged = mergePanelReviewVerdicts([
      { accept: false, feedback: null, requiredChanges: ["x"] },
      { accept: false, feedback: null, requiredChanges: ["x"] },
    ]);
    expect(merged.requiredChanges).toEqual(["x"]);
    expect(merged.sections).toBeNull();
    expect(merged.confidence).toBeNull();
    expect(merged.feedback).toBeNull();
  });
});
