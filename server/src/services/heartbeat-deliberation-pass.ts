import type { AdapterExecutionResult } from "@workcell/adapter-utils";
import type { ReviewVerdictSections } from "./agent-deliberation.js";

// Execution-layer dual-brain (deliberation) loop — OpenRouter-Fusion style.
//
// When a deliberation-enabled agent runs an issue, its heartbeat run FUSES two
// brains INSIDE the single run instead of one adapter turn:
//   work (brain A, canonical) → candidate(s) (brain B + panel, independent, in
//   parallel) → synthesize (brain A merges into the final). It lives at the
//   executeRun chokepoint, so it covers EVERY assignment path uniformly and holds
//   the one issue execution lock (it can never run concurrently with the issue's
//   QA stage, the bug the retired pair-round path caused).
//
// SAFETY model (why this is a thin, low-risk wrapper):
//  - Pass 0 (work) is BYTE-FOR-BYTE the existing single adapter call — the caller
//    passes `session: undefined` and runs the exact same object. If no candidate
//    produces anything usable, the run is identical to today (the work stands).
//  - The loop returns ONE AdapterExecutionResult (the synthesize pass's result,
//    or the work pass's if synthesis is skipped/fails) with aggregated usage/cost
//    + a passes[] breakdown. Everything downstream consumes that one result.
//  - CANDIDATE passes are INDEPENDENT (fresh sessions) and do NOT edit the
//    workspace — they inspect the working tree + the work summary and return a
//    text proposal. They share the work brain's cwd, so running them in parallel
//    is safe. The SYNTHESIZE pass (brain A, resumes the work session) is the only
//    one that edits — reconciling everything into the final.
//  - Bounded by an aggregate wall-clock budget; terminal status is re-checked
//    between phases so a cancel breaks the run.
//  - A failed/timed-out WORK pass returns that result (the run fails, as today).
//    A failed candidate is skipped (non-fatal); a failed synthesize is non-fatal
//    too — the work already stands.

export interface DeliberationSession {
  legacySessionId: string | null;
  params: Record<string, unknown> | null;
  displayId: string | null;
}

export interface DeliberationPassInput {
  brain: "A" | "B";
  kind: "work" | "candidate" | "synthesize";
  taskMarkdown: string;
  // null = inherit the agent's configured model; a string overrides it.
  model: string | null;
  // WC-XADAPT: the adapter type this pass runs on. null = the agent's own work
  // adapter (today's path). A different value runs the pass on that local adapter
  // (cross-vendor review) — the caller resolves it and uses a fresh session.
  adapter?: string | null;
  // WC-PANEL: start a FRESH session for this pass (no resume) instead of pass-0
  // semantics. Independent panel members use this so they neither inherit the
  // run's original work call nor see each other (fusion-fable independence). They
  // still see the working tree (same cwd) + the work summary in the prompt.
  fresh?: boolean;
  // undefined (and not `fresh`) ⇒ pass 0: use the run's ORIGINAL incoming session
  // + base context (the exact existing call). A value ⇒ resume that session.
  session?: DeliberationSession;
}

export interface DeliberationPassOutput {
  result: AdapterExecutionResult;
  // Next session computed by the caller (resolveNextSessionState) from result,
  // threaded into the following pass.
  nextSession: DeliberationSession;
}

export type RunDeliberationPass = (
  input: DeliberationPassInput,
) => Promise<DeliberationPassOutput>;

export interface DeliberationPassRecord {
  pass: number;
  brain: "A" | "B";
  kind: "work" | "candidate" | "synthesize";
  model: string | null;
  // WC-XADAPT: the adapter this pass ran on (null = the agent's work adapter).
  adapter?: string | null;
  verdict?: "accept" | "revise";
  // WC-REVDX: the review brain's confidence (0..1) for this verdict, when given.
  confidence?: number | null;
  // WC-PANEL: for a panel round, which member index this review was (0-based).
  panelMember?: number;
  // WC-REVDX (observability): the structured critique, surfaced on the run's
  // deliberation.pass event so the board can see WHY a review revised.
  summary?: string | null;
  requiredChanges?: string[];
  sections?: ReviewVerdictSections | null;
  costUsd: number | null;
  durationMs: number;
}

// A review-panel member: an independent reviewer with its own model/adapter.
export interface DeliberationReviewMember {
  model: string | null;
  adapter: string | null;
}

// The structured verdict a review pass yields (a superset of the legacy
// {accept, feedback}). New fields are OPTIONAL so existing callers/test stubs
// that return only {accept, feedback} keep working; the loop degrades to the
// legacy behavior when they are absent.
export interface DeliberationReviewVerdict {
  accept: boolean;
  feedback: string | null;
  // Actionable items that GROUND the revise pass (fusion-fable). When present,
  // the revise prompt asks the work brain to address these specific changes.
  requiredChanges?: string[];
  confidence?: number | null;
  sections?: ReviewVerdictSections | null;
  // One-line overall judgment (surfaced on the run timeline).
  summary?: string | null;
}

export interface RunDeliberationPassesOptions {
  runPass: RunDeliberationPass;
  baseTaskMarkdown: string;
  workModel: string | null;
  reviewModel: string | null;
  // WC-XADAPT: the agent's own (work) adapter, and the single review brain's
  // adapter. When reviewAdapter differs from workAdapter the review runs
  // cross-vendor (fresh session). Both optional (default null = same adapter).
  workAdapter?: string | null;
  reviewAdapter?: string | null;
  // WC-PANEL: "single" (default) = one brainB review per round; "panel" = the
  // panelMembers review independently each round and the loop aggregates by
  // consensus (≥ panelMinAgree accepts ⇒ accept).
  reviewMode?: "single" | "panel";
  panelMembers?: DeliberationReviewMember[];
  panelMinAgree?: number;
  // WC-TRACK: how reviewers frame their critique (artifact vs research).
  track?: "auto" | "a" | "b";
  maxRounds: number;
  budgetMs: number;
  now: () => number;
  parseVerdict: (text: string) => DeliberationReviewVerdict;
  isTerminal: () => Promise<boolean>;
  onPassEvent: (record: DeliberationPassRecord) => Promise<void>;
  onBoundaryLog: (message: string) => Promise<void>;
  logWarn: (message: string, err?: unknown) => void;
}

function passFailed(result: AdapterExecutionResult): boolean {
  return Boolean(result.timedOut) || (result.exitCode ?? 0) !== 0 || Boolean(result.errorMessage);
}

// WC-TRACK (fusion-fable): focus the reviewer. "a" = artifact → exercise the
// thing and judge observed behavior; "b" = research → structured synthesis of
// claims. "auto"/absent keeps the balanced default.
function trackDirective(track: "auto" | "a" | "b" | undefined): string {
  if (track === "a") {
    return "TRACK A (artifact): treat the work as a buildable artifact. RUN it / its checks / its tests and judge ONLY by observed behavior; cite the concrete failing command or output for any contradiction.";
  }
  if (track === "b") {
    return "TRACK B (research): treat the work as analysis/recommendation. Independently VERIFY each material claim against primary sources/the spec; surface contradictions and unsupported assertions explicitly.";
  }
  return "Pick the right lens: if the work is a buildable artifact, RUN it and judge by observed behavior; if it is analysis, verify each claim against the spec/sources.";
}

// Fusion CANDIDATE prompt: a second brain independently proposes its OWN solution
// to the same task. It does NOT edit the workspace (the work brain already did,
// and parallel candidates share the cwd) — it inspects the working tree + the work
// brain's summary, then writes a concrete, complete ALTERNATIVE solution: the
// approach it would take and the specific changes it would make (files, functions,
// key logic). Independence is the point — a different mind surfaces a different,
// possibly better take that the synthesizer can then fold in.
function buildCandidatePrompt(
  baseTask: string,
  workSummary: string | null,
  track?: "auto" | "a" | "b",
): string {
  return [
    "# Dual-brain fusion — CANDIDATE pass (an independent second solution)",
    "",
    "Another brain (the WORK brain) just implemented the task below in this workspace.",
    "You are an INDEPENDENT problem-solver. Do NOT edit files in this pass. Instead inspect",
    "the working tree and the work summary, then propose YOUR OWN best, complete solution to",
    "the task — the approach you would take and the SPECIFIC, concrete changes you would make",
    "(name the files, functions, and key logic). Diverge wherever you genuinely think there is",
    "a better way; agree where the work is already right.",
    "",
    trackDirective(track),
    "",
    workSummary ? `## What the work brain reported\n${workSummary}` : "",
    "",
    "## Task",
    baseTask,
  ].join("\n");
}

// Fusion SYNTHESIZE prompt: the work brain (synthesizer) reconciles its OWN work
// with the independent candidate solution(s) into the single best final result —
// applying actual edits in the workspace, then reporting what changed and how it
// was verified.
function buildSynthesizePrompt(
  baseTask: string,
  workSummary: string | null,
  candidates: string[],
): string {
  const blocks = candidates.map((c, i) => `### Candidate ${i + 1}\n${c}`).join("\n\n");
  return [
    "# Dual-brain fusion — SYNTHESIZE pass (merge into the best final result)",
    "",
    "You implemented the task below. One or more INDEPENDENT brains then proposed their own",
    "solutions to the same task (below). Reconcile everything into the SINGLE best result NOW",
    "with actual edits in the workspace: keep what your work got right, adopt the better ideas",
    "from the candidates, drop weak or wrong parts, and resolve conflicts on the merits. Then",
    "report what you changed and how you verified it.",
    "",
    workSummary ? `## Your work (the current workspace state)\n${workSummary}\n` : "",
    "## Independent candidate solutions",
    blocks,
    "",
    "## Original task",
    baseTask,
  ].join("\n");
}

function costOf(result: AdapterExecutionResult): number | null {
  return typeof result.costUsd === "number" ? result.costUsd : null;
}

// WC-PANEL: aggregate a panel round's (non-accepting) verdicts into ONE revise
// verdict for the work brain — dedup requiredChanges across members, concatenate
// distinct feedback, union the blind-spot/contradiction findings, and take the
// LOWEST confidence (the most skeptical panelist wins). Pure + total.
export function mergePanelReviewVerdicts(
  verdicts: DeliberationReviewVerdict[],
): DeliberationReviewVerdict {
  const requiredChanges: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (item: string) => {
    const key = item.trim().toLowerCase();
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      requiredChanges.push(item.trim());
    }
  };
  for (const v of verdicts) for (const c of v.requiredChanges ?? []) pushUnique(c);

  const feedback = verdicts
    .map((v) => v.feedback)
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    .join("\n");

  const confidences = verdicts
    .map((v) => v.confidence)
    .filter((c): c is number => typeof c === "number");
  const confidence = confidences.length > 0 ? Math.min(...confidences) : null;

  const unionSection = (pick: (s: ReviewVerdictSections) => string[]): string[] => {
    const out: string[] = [];
    const s = new Set<string>();
    for (const v of verdicts) {
      if (!v.sections) continue;
      for (const item of pick(v.sections)) {
        const key = item.trim().toLowerCase();
        if (key && !s.has(key)) { s.add(key); out.push(item.trim()); }
      }
    }
    return out;
  };
  const sections: ReviewVerdictSections = {
    consensus: unionSection((s) => s.consensus),
    contradictions: unionSection((s) => s.contradictions),
    partialCoverage: unionSection((s) => s.partialCoverage),
    uniqueInsights: unionSection((s) => s.uniqueInsights),
    blindSpots: unionSection((s) => s.blindSpots),
  };
  const anySection = Object.values(sections).some((arr) => arr.length > 0);

  return {
    accept: false,
    feedback: feedback.length > 0 ? feedback : null,
    requiredChanges,
    confidence,
    sections: anySection ? sections : null,
  };
}

// Build the single aggregated result the caller hands downstream: the final
// work pass's result verbatim, overlaying only summed usage + summed cost and a
// passes[] breakdown. All other fields (session, exitCode, timedOut, errorFamily,
// summary, …) pass through from the final work pass so outcome + session
// continuity behave exactly as a single run.
function aggregate(
  finalWork: AdapterExecutionResult,
  passes: DeliberationPassRecord[],
  totals: { inputTokens: number; outputTokens: number; cachedInputTokens: number; hasUsage: boolean },
  totalCostUsd: number | null,
): AdapterExecutionResult {
  return {
    ...finalWork,
    ...(totals.hasUsage
      ? {
          usage: {
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cachedInputTokens: totals.cachedInputTokens,
          },
        }
      : {}),
    ...(totalCostUsd != null ? { costUsd: totalCostUsd } : {}),
    resultJson: {
      ...(finalWork.resultJson ?? {}),
      deliberationPasses: passes,
    },
  };
}

export async function runDeliberationPasses(
  opts: RunDeliberationPassesOptions,
): Promise<AdapterExecutionResult> {
  const {
    runPass, baseTaskMarkdown, workModel, reviewModel,
    reviewAdapter = null, reviewMode = "single", panelMembers = [], track = "auto",
    budgetMs, now, isTerminal, onPassEvent, onBoundaryLog, logWarn,
  } = opts;

  // The independent CANDIDATE brains whose solutions we fuse: a single brain B,
  // or the panel of independent members.
  const usePanel = reviewMode === "panel" && panelMembers.length > 0;
  const candidates: DeliberationReviewMember[] = usePanel
    ? panelMembers
    : [{ model: reviewModel, adapter: reviewAdapter }];

  const passes: DeliberationPassRecord[] = [];
  const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, hasUsage: false };
  let totalCostUsd: number | null = null;
  let passNo = 0;
  const start = now();

  const record = async (
    brain: "A" | "B",
    kind: "work" | "candidate" | "synthesize",
    model: string | null,
    result: AdapterExecutionResult,
    durationMs: number,
    extra?: { adapter?: string | null; panelMember?: number },
  ) => {
    if (result.usage) {
      totals.hasUsage = true;
      totals.inputTokens += result.usage.inputTokens ?? 0;
      totals.outputTokens += result.usage.outputTokens ?? 0;
      totals.cachedInputTokens += result.usage.cachedInputTokens ?? 0;
    }
    const c = costOf(result);
    if (c != null) totalCostUsd = (totalCostUsd ?? 0) + c;
    const rec: DeliberationPassRecord = {
      pass: passNo++,
      brain,
      kind,
      model,
      costUsd: c,
      durationMs,
      ...(extra?.adapter ? { adapter: extra.adapter } : {}),
      ...(extra?.panelMember !== undefined ? { panelMember: extra.panelMember } : {}),
    };
    passes.push(rec);
    try {
      await onPassEvent(rec);
    } catch (err) {
      logWarn("dual-brain: failed to emit pass event", err);
    }
  };

  // ---- WORK (brain A, canonical) — exactly today's single call. ----
  let t = now();
  const work = await runPass({ brain: "A", kind: "work", taskMarkdown: baseTaskMarkdown, model: workModel });
  await record("A", "work", workModel, work.result, now() - t);

  // A failed work pass, an externally-set terminal status, or a spent budget ends
  // the run here with the work result — identical to today.
  if (passFailed(work.result) || (await isTerminal()) || now() - start > budgetMs) {
    return aggregate(work.result, passes, totals, totalCostUsd);
  }

  // ---- CANDIDATES (independent, in parallel) — each proposes its own solution. ----
  // OpenRouter-Fusion style: brain B (+ panel) each draft an INDEPENDENT solution
  // (a different mind ⇒ a divergent take). They do NOT edit the workspace (they
  // share the work brain's cwd), so running them concurrently is safe; each
  // returns a text proposal the synthesizer then folds in.
  await onBoundaryLog(
    `dual-brain: generating ${candidates.length} independent candidate${candidates.length === 1 ? "" : "s"}`,
  );
  const candidatePrompt = buildCandidatePrompt(baseTaskMarkdown, work.result.summary ?? null, track);
  const candidateRuns = await Promise.all(
    candidates.map(async (member, m) => {
      const ct = now();
      try {
        const out = await runPass({
          brain: "B",
          kind: "candidate",
          taskMarkdown: candidatePrompt,
          model: member.model,
          adapter: member.adapter,
          fresh: true, // independent: a brand-new session, not the work brain's
        });
        return { member, m, out, durationMs: now() - ct };
      } catch (err) {
        // A candidate that throws is non-fatal — skip it.
        logWarn("dual-brain: candidate pass threw; skipping", err);
        return null;
      }
    }),
  );

  const proposals: string[] = [];
  for (const cr of candidateRuns) {
    if (!cr) continue;
    await record("B", "candidate", cr.member.model, cr.out.result, cr.durationMs, {
      adapter: cr.member.adapter,
      panelMember: usePanel ? cr.m : undefined,
    });
    if (passFailed(cr.out.result)) continue;
    const summary = cr.out.result.summary;
    if (typeof summary === "string" && summary.trim().length > 0) proposals.push(summary);
  }

  // No usable candidate, or the run went terminal / over budget while generating →
  // the work stands (nothing to fuse, like a no-op review today).
  if (proposals.length === 0 || (await isTerminal()) || now() - start > budgetMs) {
    return aggregate(work.result, passes, totals, totalCostUsd);
  }

  // ---- SYNTHESIZE (brain A, canonical, resume the work session) — merge into one. ----
  await onBoundaryLog("dual-brain: synthesize pass starting");
  t = now();
  const synth = await runPass({
    brain: "A",
    kind: "synthesize",
    taskMarkdown: buildSynthesizePrompt(baseTaskMarkdown, work.result.summary ?? null, proposals),
    model: workModel,
    session: work.nextSession,
  });
  await record("A", "synthesize", workModel, synth.result, now() - t);

  // A failed synthesize is NON-FATAL: the work already stands, so a flaky merge
  // must not fail the run — return the work result. A clean synthesize IS the
  // final result.
  if (passFailed(synth.result)) {
    return aggregate(work.result, passes, totals, totalCostUsd);
  }
  return aggregate(synth.result, passes, totals, totalCostUsd);
}
