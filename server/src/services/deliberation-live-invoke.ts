import { randomUUID } from "node:crypto";
import {
  runAdapterSingleTurn,
  type SingleTurnAdapter,
} from "./adapter-single-turn.js";
import { billedCostCentsFromAdapterResult } from "./cost-mapping.js";
import type { DeliberationInvoke } from "./agent-deliberation.js";

// WC-206 (deliberation mode, slice 3): the LIVE adapter-backed DeliberationInvoke.
//
// The dual-brain engine (WC-204, server/src/services/agent-deliberation.ts) is
// invoke-agnostic — it routes every brain turn through an injected `invoke`
// callback (raw brain text in → out) and parses the verdict itself. WC-204/205
// shipped only the deterministic stub + config; THIS is the live implementation
// that actually drives two real models: for each brain turn it builds the turn
// prompt, runs ONE adapter turn via the WC-57 runAdapterSingleTurn helper, and
// returns the adapter's raw stdout for the engine to parse.
//
// ADAPTER + MODEL SELECTION (WC-208): each brain independently chooses BOTH its
// adapter and its model. The engine threads a per-turn `adapter` + `model` into
// each invoke call:
//   - adapter: when the brain set an adapter override (e.g. brain A =
//     claude_local, brain B = codex_local) that adapter type drives the turn;
//     when null we fall back to the agent's own adapterType (then claude_local).
//     So brain A and brain B can run on DIFFERENT CLIs in the same run.
//   - model: when the brain set a model it is layered onto the resolved
//     adapter's adapterConfig as `config.model`; when null we fall back to the
//     agent's configured model already in baseConfig. claude-local + codex-local
//     both read asString(config.model) — the same key heartbeat / pair-turn use.
//
// FLAG-GATED AT THE ROUTE: the deliberate route only builds this live invoke
// when WORKCELL_PAIR_LIVE_LLM is set (reusing the pair flag) so CI / dev never
// spend by accident; tests inject a deterministic stub invoke instead and this
// module is not exercised against a real CLI. The `resolveAdapter` seam still
// lets a unit test drive this factory with a fake adapter if desired.
//
// COST: each turn's billed cents are derived from the AdapterExecutionResult via
// the shared billedCostCentsFromAdapterResult mapping (identical to the pair /
// heartbeat ledger) and surfaced through the optional `onCost` callback so the
// route can sum the run's total cost for its activity event.
//
// WC-211 (finding 1 — resilience): per-turn timeout. A live smoke test had a
// codex_local brain turn hang for 5+ min, leaving the async run stuck
// status='running' forever (the fire-and-forget design never crashed, but never
// resolved either). codex_local turns were observed to be very slow / hung in
// local testing (likely an env/CLI setup issue) — we do NOT diagnose the root
// cause here; instead each brain turn is BOUNDED so a slow/hung brain fails the
// run gracefully regardless of why it stalled. We use the adapter's own timeout
// knob: `config.timeoutSec` (claude-local + codex-local both honor it and KILL
// the child CLI process on timeout — the process kill is the adapter's job), and
// then convert a timed-out adapter result into a THROWN error so it propagates
// through runAgentDeliberation to the run service's try/catch, which marks the
// run status='failed' with the timeout message. We also belt-and-suspenders the
// adapter knob with a Promise.race so a turn that hangs WITHOUT honoring the
// adapter timeout (e.g. a stuck promise that never settles) still rejects within
// the bound.

// Default per-turn timeout for a single deliberation brain turn (ms). A slow/
// hung brain that exceeds this fails the whole run (status='failed') instead of
// stalling it forever. 120s is generous for a single live model turn (live
// claude_local turns run ~75s) while still bounding a wedged codex_local turn.
const DELIBERATION_TURN_TIMEOUT_MS = 120_000;

export interface BuildLiveDeliberationInvokeOptions {
  // The agent the deliberation runs for. Supplies the adapter type/config and
  // the fallback when a brain has no explicitly-configured model.
  agent: {
    id: string;
    companyId: string;
    name: string;
    adapterType: string | null;
    adapterConfig: unknown;
  };
  // Stable prefix for the per-turn runId (one turn = one adapter run).
  runIdBase: string;
  // Called once per turn with that turn's billed cost in integer cents, so the
  // caller can accumulate the run total. Optional.
  onCost?: (costCents: number) => void;
  // Test seam: inject a fake adapter module. Defaults (in runAdapterSingleTurn)
  // to the real getServerAdapter registry lookup.
  resolveAdapter?: (type: string) => SingleTurnAdapter;
  // WC-211: override the per-turn timeout (ms). Defaults to
  // DELIBERATION_TURN_TIMEOUT_MS. Tests pass a tiny value so a hung-invoke test
  // resolves to a timeout failure quickly without fake timers.
  turnTimeoutMs?: number;
}

// Build the round-0 "propose" prompt (brain A drafts the initial conclusion).
function buildProposePrompt(task: string): string {
  return `You are Brain A — one of two minds inside a single agent collaborating to produce the best possible result.\n\nTask:\n${task}\n\nProduce your best, complete, concrete conclusion/draft. Your partner (Brain B) will review it.`;
}

// Build the "review" prompt for a reviewing brain. The engine parses the JSON
// verdict out of the returned stdout; this prompt asks for EXACTLY that JSON.
function buildReviewPrompt(brain: "A" | "B", task: string, currentProposal: string): string {
  return `You are Brain ${brain} — one of two minds inside a single agent. Your partner produced the current proposal; review it critically and decide.\n\nTask:\n${task}\n\nCurrent proposal:\n---\n${currentProposal}\n---\n\nIf it is already good enough to ship, ACCEPT. Otherwise produce an improved REVISED version (the FULL revised proposal, not just notes).\n\nRespond with EXACTLY one JSON object and nothing else:\n{"verdict":"accept"}\nor\n{"verdict":"revise","revision":"<the full improved proposal>","feedback":"<what you changed and why, 1-2 sentences>"}`;
}

export function buildLiveDeliberationInvoke(
  options: BuildLiveDeliberationInvokeOptions,
): DeliberationInvoke {
  const { agent, runIdBase, onCost, resolveAdapter } = options;
  const turnTimeoutMs = options.turnTimeoutMs ?? DELIBERATION_TURN_TIMEOUT_MS;
  const agentAdapterType = agent.adapterType ?? "claude_local";
  const baseConfig =
    typeof agent.adapterConfig === "object" &&
    agent.adapterConfig !== null &&
    !Array.isArray(agent.adapterConfig)
      ? (agent.adapterConfig as Record<string, unknown>)
      : {};

  return async ({ brain, role, adapter, model, task, currentProposal, round }) => {
    const prompt =
      role === "propose" || currentProposal === null
        ? buildProposePrompt(task)
        : buildReviewPrompt(brain, task, currentProposal);

    // WC-208 — per-brain adapter selection: the brain's own adapter override
    // drives this turn; when absent we fall back to the agent's adapterType
    // (then claude_local). So brain A and brain B can run on different CLIs.
    const adapterType = adapter ?? agentAdapterType;

    // Per-brain model selection: layer the brain's model onto the agent's
    // adapterConfig (model === null → fall back to the agent's configured model
    // already in baseConfig). claude-local + codex-local both read config.model.
    //
    // WC-211: also pin `timeoutSec` so the adapter bounds (and KILLs) the child
    // CLI process for this turn. resolveAdapterExecutionTargetTimeoutSec treats
    // any positive config.timeoutSec as the run timeout. We spread baseConfig
    // first then OVERRIDE timeoutSec on purpose so a deliberation turn is ALWAYS
    // bounded, even if the agent's own adapterConfig set a longer (or zero =
    // unbounded) timeoutSec.
    const config: Record<string, unknown> = {
      ...baseConfig,
      ...(model ? { model } : {}),
      timeoutSec: Math.ceil(turnTimeoutMs / 1000),
    };
    const runId = `${runIdBase}-b${brain}-${role}-r${round}-${randomUUID()}`;

    // WC-211: bound the turn TWICE. (1) config.timeoutSec above lets the adapter
    // kill the CLI process. (2) this Promise.race is a JS-level backstop so a
    // turn that hangs WITHOUT the adapter honoring its timeout (e.g. a promise
    // that never settles) still rejects within turnTimeoutMs. The thrown error
    // propagates through runAgentDeliberation to the run service's try/catch,
    // which marks the run status='failed' with this message.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const turnPromise = runAdapterSingleTurn({
      adapterType,
      runId,
      agent: {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        adapterType,
        adapterConfig: config,
      },
      // claude-local reads the model from `config` (asString(config.model)); the
      // brain prompt rides on context.workcellTaskMarkdown (execute.ts folds it
      // into the model prompt), mirroring the pair-turn live invoker.
      config,
      context: { workcellTaskMarkdown: prompt },
      resolveAdapter,
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `deliberation brain ${brain} turn timed out after ${Math.round(turnTimeoutMs / 1000)}s`,
          ),
        );
      }, turnTimeoutMs);
    });

    let result;
    try {
      ({ result } = await Promise.race([turnPromise, timeoutPromise]));
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    // WC-211: an adapter that honored its OWN timeoutSec returns timedOut=true
    // (it killed the CLI) rather than throwing. Convert that into the same thrown
    // timeout error so the run is marked failed instead of the engine treating an
    // empty summary as a "revise" and silently advancing the loop.
    if (result.timedOut) {
      throw new Error(
        `deliberation brain ${brain} turn timed out after ${Math.round(turnTimeoutMs / 1000)}s`,
      );
    }

    if (onCost) {
      onCost(
        billedCostCentsFromAdapterResult({
          costUsd: result.costUsd,
          billingType: result.billingType,
        }),
      );
    }

    // WC-207 (smoke-test fix): return the adapter's parsed assistant TEXT
    // (result.summary), NOT raw stdout. For stream-json adapters (claude-local)
    // stdout is the NDJSON protocol stream (hook/init/result events), so passing
    // it to the engine made each brain "see" protocol garbage AND made the
    // verdict parser grab the first system-hook JSON instead of the model's
    // {"verdict":...} (which is buried in the stream's `result` event).
    // claude-local sets summary to the final assistant text
    // (parsedStream.summary || result.result); codex-local likewise. An adapter
    // failure (no summary) → "" → the engine's defensive parse treats it as a
    // revise carrying empty text, advancing the loop safely.
    return result.summary ?? "";
  };
}
