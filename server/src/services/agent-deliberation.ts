// Dual-brain deliberation engine — OpenRouter Fusion style (parallel generate +
// synthesize).
//
// CONCEPT: when an agent has deliberation enabled it has TWO independently
// configured brains — brain A (model A) and brain B (model B, possibly a
// DIFFERENT model). Instead of a sequential critique loop, the agent's work runs
// as a FUSION:
//
//   round 0 (parallel):   brain A and brain B each draft a candidate answer
//                         INDEPENDENTLY (neither sees the other's draft).
//   round 1 (synthesize): the synthesizer brain (default A) reads BOTH candidates
//                         and reconciles them into one stronger final answer.
//
// This mirrors OpenRouter's Fusion: most of the lift comes from the synthesis
// step itself — even two passes of the SAME model diverge, and a synthesizer that
// reconciles them beats a single shot; two DIFFERENT models stack diversity on
// top.
//
// INVOKE-AGNOSTIC: this engine never talks to an LLM directly. The caller injects
// a single-turn `invoke` (raw brain text in → out): role 'generate' (draft a
// candidate, candidates=[]) or 'synthesize' (merge the given candidates). Tests
// pass a deterministic stub; the live wiring routes `invoke` through the
// single-turn adapter helper. Keeping the seam here verifies fusion hermetically.
//
// VERDICT-PARSE CONVENTION: a reviewer's raw text must encode its verdict as a
// JSON object. We scan for the FIRST balanced JSON object in the text and read:
//   { "verdict": "accept" }
//   { "verdict": "revise", "revision": "<improved text>", "feedback": "<why>" }
// Parsing is DEFENSIVE: malformed / missing / non-object JSON, or an
// unrecognized verdict, is treated as a REVISE whose revision is the reviewer's
// whole raw text — so the loop always makes progress and never throws on noise.

export type DeliberationBrain = "A" | "B";
// Fusion roles: each brain GENERATEs a candidate in parallel; the synthesizer
// brain SYNTHESIZEs the candidates into the final answer.
export type DeliberationRole = "generate" | "synthesize";
export type DeliberationAction = "generate" | "synthesize";

// The single-turn brain invocation the engine depends on. For a 'generate' turn
// `candidates` is empty (the brain drafts from the task alone); for the
// 'synthesize' turn `candidates` holds the parallel candidate answers to merge.
// `round` is 0 for the generate turns and 1 for the synthesize turn.
//
// WC-208 (per-brain adapter): `adapter` is the adapter type this brain turn runs
// on (null = inherit the agent's own adapterType). It is threaded alongside the
// per-brain `model` so brain A and brain B can run on DIFFERENT adapters.
export type DeliberationInvoke = (args: {
  brain: DeliberationBrain;
  role: DeliberationRole;
  adapter: string | null;
  model: string | null;
  task: string;
  candidates: string[];
  round: number;
}) => Promise<string>;

export interface DeliberationTranscriptEntry {
  round: number;
  brain: DeliberationBrain;
  action: DeliberationAction;
  content: string;
  feedback: string | null;
}

export interface DeliberationResult {
  finalOutput: string;
  acceptedBy: DeliberationBrain | null;
  rounds: number;
  transcript: DeliberationTranscriptEntry[];
}

export interface RunAgentDeliberationInput {
  task: string;
  // WC-208 (per-brain adapter): each brain carries an optional adapter override
  // (null/absent = inherit the agent's adapterType) alongside its model.
  brainA: { adapter?: string | null; model: string | null };
  brainB: { adapter?: string | null; model: string | null };
  // Which brain synthesizes the two candidates into the final answer (default A).
  synthesizer?: DeliberationBrain;
  // Legacy: the old sequential loop's review cap. Fusion is a single generate +
  // synthesize pass, so callers may still pass it but it is unused.
  maxRounds?: number;
  invoke: DeliberationInvoke;
  // WC-209 (async + persist): optional hook fired right after each transcript
  // entry is pushed (the initial propose, then each accept/revise). Lets a
  // caller persist the transcript INCREMENTALLY as turns are produced — so an
  // async run's turns stream into the DB instead of materializing only when the
  // whole (~5 min) loop finishes. Awaited so a persistence write completes
  // before the next turn; absent for the hermetic / default path (engine
  // behavior is otherwise unchanged).
  onTurn?: (entry: DeliberationTranscriptEntry) => Promise<void> | void;
}

// WC-REVDX (5-section structured verdict, fusion-fable blueprint): a review
// brain returns a structured critique instead of a bare accept/revise. Each
// section is a list of short bullet findings; all are optional (a terse reviewer
// may return none). `requiredChanges` is the actionable subset that GROUNDS the
// revise pass (the work brain addresses these specific items, not vague prose).
export interface ReviewVerdictSections {
  consensus: string[];        // parts provably right
  contradictions: string[];   // conflicts with facts / the spec
  partialCoverage: string[];  // addressed incompletely
  uniqueInsights: string[];   // correct points the reviewer independently found
  blindSpots: string[];       // critical gaps
}

export type ReviewVerdict =
  | {
      verdict: "accept";
      confidence: number | null;
      requiredChanges: string[];
      sections: ReviewVerdictSections | null;
      summary: string | null;
    }
  | {
      verdict: "revise";
      // The full improved text (used by the standalone runAgentDeliberation
      // engine, where the reviewer rewrites). The execution-layer loop ignores
      // this and drives its revise pass from requiredChanges/feedback instead.
      revision: string;
      feedback: string | null;
      confidence: number | null;
      requiredChanges: string[];
      sections: ReviewVerdictSections | null;
      summary: string | null;
    };

// Scan for the first balanced top-level JSON object in `text` and return its
// parsed value, or null if none parses. Walks brace depth so a `{...}` embedded
// in surrounding prose (the common LLM case) is found without a greedy regex.
function extractFirstJsonObject(text: string): unknown {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break; // unbalanced/invalid from this start; try the next "{"
          }
        }
      }
    }
  }
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Trimmed, non-empty strings from a JSON array (anything else → dropped).
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}

// A confidence in [0,1]; non-finite/absent → null.
function asConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

// Extract the 5 fusion-fable sections; null when the reviewer supplied none of
// them (so a terse JSON `{"verdict":"accept"}` doesn't fabricate empty sections).
function parseVerdictSections(obj: Record<string, unknown>): ReviewVerdictSections | null {
  const sections: ReviewVerdictSections = {
    consensus: asStringArray(obj.consensus),
    contradictions: asStringArray(obj.contradictions),
    partialCoverage: asStringArray(obj.partialCoverage),
    uniqueInsights: asStringArray(obj.uniqueInsights),
    blindSpots: asStringArray(obj.blindSpots),
  };
  const anyPresent = Object.values(sections).some((arr) => arr.length > 0);
  return anyPresent ? sections : null;
}

// Defensively parse a reviewer's raw text into a verdict. Per the convention,
// anything that does not cleanly say `accept` (or a `revise` with a usable
// revision) is treated as a revise carrying the whole raw text — so the loop
// keeps progressing and a noisy / prose-only reviewer never crashes the engine.
export function parseReviewVerdict(rawText: string): ReviewVerdict {
  const parsed = extractFirstJsonObject(rawText);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const verdict = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : null;
    const confidence = asConfidence(obj.confidence);
    const requiredChanges = asStringArray(obj.requiredChanges);
    const sections = parseVerdictSections(obj);
    const summary = asNonEmptyString(obj.summary);
    if (verdict === "accept") {
      return { verdict: "accept", confidence, requiredChanges, sections, summary };
    }
    if (verdict === "revise") {
      // Prefer an explicit revision (standalone engine), else stitch one from the
      // requiredChanges, else fall back to the whole raw text so a "revise" with
      // no usable body still advances the proposal.
      const revision =
        asNonEmptyString(obj.revision)
        ?? (requiredChanges.length > 0 ? requiredChanges.map((c, i) => `${i + 1}. ${c}`).join("\n") : null)
        ?? rawText;
      // Feedback grounds the revise pass: prefer explicit feedback, else the
      // requiredChanges list, else any summary.
      const feedback =
        asNonEmptyString(obj.feedback)
        ?? (requiredChanges.length > 0 ? requiredChanges.map((c, i) => `${i + 1}. ${c}`).join("\n") : null)
        ?? summary;
      return { verdict: "revise", revision, feedback, confidence, requiredChanges, sections, summary };
    }
  }
  // Unparseable JSON, non-object, or unrecognized verdict → treat as a revise
  // whose revision is the reviewer's entire raw output (the local "healing"
  // fallback: a noisy/prose-only reviewer never crashes or stalls the loop).
  return {
    verdict: "revise",
    revision: rawText,
    feedback: null,
    confidence: null,
    requiredChanges: [],
    sections: null,
    summary: null,
  };
}

// Run the dual-brain FUSION: both brains generate a candidate in parallel, then
// the synthesizer brain merges the two into the final answer. See the module
// header. Pure with respect to `invoke`. `acceptedBy` in the result carries the
// SYNTHESIZER brain (the one that produced the final) — kept for storage compat.
export async function runAgentDeliberation(
  input: RunAgentDeliberationInput,
): Promise<DeliberationResult> {
  const { task, brainA, brainB, invoke, onTurn } = input;
  const synthesizer: DeliberationBrain = input.synthesizer ?? "A";
  const modelFor = (brain: DeliberationBrain): string | null =>
    brain === "A" ? brainA.model : brainB.model;
  // WC-208: resolve each brain's adapter override (null when absent) so the
  // live invoke can route the turn to that brain's adapter.
  const adapterFor = (brain: DeliberationBrain): string | null =>
    (brain === "A" ? brainA.adapter : brainB.adapter) ?? null;

  const transcript: DeliberationTranscriptEntry[] = [];
  // Push a transcript entry AND notify the optional onTurn hook (awaited so a
  // persistence write lands before the next entry).
  const pushTurn = async (entry: DeliberationTranscriptEntry): Promise<void> => {
    transcript.push(entry);
    if (onTurn) await onTurn(entry);
  };

  // Round 0 — PARALLEL GENERATION: both brains draft a candidate independently
  // (neither sees the other's draft). Run concurrently; the divergence between
  // the two passes is what the synthesizer later reconciles.
  const [candidateA, candidateB] = await Promise.all([
    invoke({ brain: "A", role: "generate", adapter: adapterFor("A"), model: modelFor("A"), task, candidates: [], round: 0 }),
    invoke({ brain: "B", role: "generate", adapter: adapterFor("B"), model: modelFor("B"), task, candidates: [], round: 0 }),
  ]);
  // Persist in a stable A→B order regardless of which promise resolved first.
  await pushTurn({ round: 0, brain: "A", action: "generate", content: candidateA, feedback: null });
  await pushTurn({ round: 0, brain: "B", action: "generate", content: candidateB, feedback: null });

  // Round 1 — SYNTHESIS: the synthesizer brain reconciles both candidates into a
  // single stronger answer (the load-bearing Fusion step).
  const finalOutput = await invoke({
    brain: synthesizer,
    role: "synthesize",
    adapter: adapterFor(synthesizer),
    model: modelFor(synthesizer),
    task,
    candidates: [candidateA, candidateB],
    round: 1,
  });
  await pushTurn({ round: 1, brain: synthesizer, action: "synthesize", content: finalOutput, feedback: null });

  return { finalOutput, acceptedBy: synthesizer, rounds: 1, transcript };
}
