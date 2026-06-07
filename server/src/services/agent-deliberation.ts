// WC-204 (deliberation mode, slice 1): the dual-brain internal-consensus engine.
//
// CONCEPT: when an agent has deliberation enabled it has TWO independently
// configured brains — brain A (model A) and brain B (model B, possibly a
// DIFFERENT model). The agent's work runs through an internal loop:
//
//   round 0:  brain A drafts a conclusion (propose)
//   then alternate reviewers, starting with B:
//     reviewer reviews the current proposal and returns a verdict:
//       - ACCEPT  → stop; the current proposal is the agent's output
//       - REVISE  → produce an improved version (+ feedback); that revision
//                   becomes the new proposal, the reviewer switches, repeat
//   stop when a brain ACCEPTs, OR maxRounds review turns elapse (then take the
//   latest proposal, acceptedBy = null).
//
// INVOKE-AGNOSTIC: this engine never talks to an LLM directly. The caller
// injects a single-turn `invoke` function (raw brain text in → out). Tests pass
// a deterministic stub; the live wiring (a later slice) will route `invoke`
// through the WC-57 single-turn adapter helper so a real model runs each turn.
// Keeping the seam here means the whole consensus loop is verified hermetically.
//
// VERDICT-PARSE CONVENTION: a reviewer's raw text must encode its verdict as a
// JSON object. We scan for the FIRST balanced JSON object in the text and read:
//   { "verdict": "accept" }
//   { "verdict": "revise", "revision": "<improved text>", "feedback": "<why>" }
// Parsing is DEFENSIVE: malformed / missing / non-object JSON, or an
// unrecognized verdict, is treated as a REVISE whose revision is the reviewer's
// whole raw text — so the loop always makes progress and never throws on noise.

export type DeliberationBrain = "A" | "B";
export type DeliberationRole = "propose" | "review";
export type DeliberationAction = "propose" | "accept" | "revise";

// The single-turn brain invocation the engine depends on. `currentProposal` is
// null only for the very first propose turn; `round` is 0 for the propose and
// increments by 1 for each review turn.
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
  currentProposal: string | null;
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
  maxRounds: number;
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

type ReviewVerdict =
  | { verdict: "accept" }
  | { verdict: "revise"; revision: string; feedback: string | null };

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

// Defensively parse a reviewer's raw text into a verdict. Per the convention,
// anything that does not cleanly say `accept` (or a `revise` with a usable
// revision) is treated as a revise carrying the whole raw text — so the loop
// keeps progressing and a noisy / prose-only reviewer never crashes the engine.
function parseReviewVerdict(rawText: string): ReviewVerdict {
  const parsed = extractFirstJsonObject(rawText);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const verdict = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : null;
    if (verdict === "accept") {
      return { verdict: "accept" };
    }
    if (verdict === "revise") {
      // Prefer the structured revision; fall back to the whole raw text so a
      // "revise" with no/empty revision still advances the proposal.
      const revision = asNonEmptyString(obj.revision) ?? rawText;
      const feedback = asNonEmptyString(obj.feedback);
      return { verdict: "revise", revision, feedback };
    }
  }
  // Unparseable JSON, non-object, or unrecognized verdict → treat as a revise
  // whose revision is the reviewer's entire raw output.
  return { verdict: "revise", revision: rawText, feedback: null };
}

function otherBrain(brain: DeliberationBrain): DeliberationBrain {
  return brain === "A" ? "B" : "A";
}

// Run the dual-brain deliberation loop. See the module header for the full
// flow + verdict convention. Pure with respect to `invoke`: the only side
// effect is calling the injected single-turn function.
export async function runAgentDeliberation(
  input: RunAgentDeliberationInput,
): Promise<DeliberationResult> {
  const { task, brainA, brainB, maxRounds, invoke, onTurn } = input;
  const modelFor = (brain: DeliberationBrain): string | null =>
    brain === "A" ? brainA.model : brainB.model;
  // WC-208: resolve each brain's adapter override (null when absent) so the
  // live invoke can route the turn to that brain's adapter.
  const adapterFor = (brain: DeliberationBrain): string | null =>
    (brain === "A" ? brainA.adapter : brainB.adapter) ?? null;

  const transcript: DeliberationTranscriptEntry[] = [];

  // WC-209: push a transcript entry AND notify the optional onTurn hook (awaited
  // so a persistence write lands before the next turn). The only behavioral
  // change vs. before is the awaited callback — the transcript array is built
  // identically.
  const pushTurn = async (entry: DeliberationTranscriptEntry): Promise<void> => {
    transcript.push(entry);
    if (onTurn) await onTurn(entry);
  };

  // Round 0: brain A drafts the initial proposal.
  let proposal = await invoke({
    brain: "A",
    role: "propose",
    adapter: adapterFor("A"),
    model: modelFor("A"),
    task,
    currentProposal: null,
    round: 0,
  });
  await pushTurn({ round: 0, brain: "A", action: "propose", content: proposal, feedback: null });

  // Review loop: alternate reviewers starting with B. `round` counts review
  // turns (1-based); we run while round <= maxRounds.
  let reviewer: DeliberationBrain = "B";
  let acceptedBy: DeliberationBrain | null = null;
  let reviewRounds = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    const rawText = await invoke({
      brain: reviewer,
      role: "review",
      adapter: adapterFor(reviewer),
      model: modelFor(reviewer),
      task,
      currentProposal: proposal,
      round,
    });
    reviewRounds = round;
    const verdict = parseReviewVerdict(rawText);

    if (verdict.verdict === "accept") {
      await pushTurn({ round, brain: reviewer, action: "accept", content: proposal, feedback: null });
      acceptedBy = reviewer;
      break;
    }

    // revise: the revision becomes the new proposal; record it, switch reviewer.
    await pushTurn({
      round,
      brain: reviewer,
      action: "revise",
      content: verdict.revision,
      feedback: verdict.feedback,
    });
    proposal = verdict.revision;
    reviewer = otherBrain(reviewer);
  }

  return {
    finalOutput: proposal,
    acceptedBy,
    rounds: reviewRounds,
    transcript,
  };
}
