import { randomUUID } from "node:crypto";
import {
  runAdapterSingleTurn,
  type SingleTurnAdapter,
} from "./adapter-single-turn.js";
import { billedCostCentsFromAdapterResult } from "./cost-mapping.js";
import {
  parsePairTurnResponse,
  type PairTurnInvokeFn,
} from "./pair-turn-executors.js";

// WC-58 (P2 §3 real LLM pair invoker): a real adapter-backed PairTurnInvokeFn.
//
// The orchestrator (WC-32) + prompt-aware executor (WC-33) already route a
// round through a pluggable `invoke` callback. WC-33 shipped only the
// deterministic stub; this is the live implementation that actually drives
// an LLM: it runs ONE adapter turn via the WC-57 runAdapterSingleTurn helper,
// then maps the AdapterExecutionResult into a PairTurnInvokeResult.
//
// FLAG-GATED: app.ts selects this only when WORKCELL_PAIR_LIVE_LLM is set;
// CI + the default app keep stubPairTurnInvoke so tests stay hermetic and the
// run-round route works without an LLM/API key. All tests here inject a
// mocked adapter via the resolveAdapter seam — the live CLI path is never
// exercised in CI.
//
// CONTEXT SCOPE: the round prompt rides on context.workcellTaskMarkdown (the
// key claude-local folds into its prompt), and the turn runs with the agent's
// configured adapterConfig — model selection via config.model (WC-97), an
// existing workspace cwd if any (WC-103), and env-secret bindings RESOLVED to
// plain values on the live path (WC-125, via the executor's resolveAdapterConfig
// option). Remaining heartbeat-parity gaps (NEW workspace realization when the
// issue has none, session continuity, JWT) stay a documented follow-up; the
// value here is the correct result→ledger mapping + graceful failure handling.
// Issue grounding = WC-59; model parity = WC-97; env-secret parity = WC-125.

export interface RealPairTurnInvokeOptions {
  // Test seam: inject a fake adapter module. Defaults (in runAdapterSingleTurn)
  // to the real getServerAdapter registry lookup.
  resolveAdapter?: (type: string) => SingleTurnAdapter;
}

export function buildRealPairTurnInvoke(
  options: RealPairTurnInvokeOptions = {},
): PairTurnInvokeFn {
  return async ({ request, promptText, agent, workspaceCwd }) => {
    const adapterType = agent.adapter ?? "claude_local";
    const runId = `pair-${request.pairGroupId}-r${request.round}-${request.role}-${randomUUID()}`;
    // WC-97: run the turn with the agent's configured adapter settings (model
    // lives in adapterConfig.model). NOTE (review L2): on the LIVE path the
    // adapterConfig env carries RESOLVED secret VALUES (WC-125), not stripped
    // bindings — only the stub/default executor path strips env. They are fed to
    // the child process env, never written into the worktree.
    // WC-103: if the issue has an existing execution workspace, run the turn in
    // that cwd so the model can see the repo — claude-local resolves cwd as
    // `config.cwd` when no live workspace context is supplied (which a pair turn
    // does not supply). Absent → the adapter's process cwd (prior behavior).
    const baseConfig = agent.adapterConfig ?? {};
    const config = workspaceCwd ? { ...baseConfig, cwd: workspaceCwd } : baseConfig;

    try {
      const { result } = await runAdapterSingleTurn({
        adapterType,
        runId,
        agent: {
          id: agent.id,
          companyId: request.companyId,
          name: agent.name,
          adapterType,
          adapterConfig: config,
        },
        // claude-local reads model from `config` (asString(config.model)) and
        // cwd from config.cwd; both now apply to the pair turn. The round prompt
        // rides on context.workcellTaskMarkdown (execute.ts folds it in).
        config,
        context: { workcellTaskMarkdown: promptText },
        resolveAdapter: options.resolveAdapter,
      });

      const costCents = billedCostCentsFromAdapterResult({
        costUsd: result.costUsd,
        billingType: result.billingType,
      });

      // Adapter-level failure (timeout / non-zero exit / error message) →
      // abort the pair gracefully instead of recording a bogus "delivered"
      // turn. The cost (if any) is still billed.
      if (result.timedOut || (result.exitCode ?? 0) !== 0 || result.errorMessage) {
        const reason = result.timedOut
          ? "timed out"
          : (result.errorMessage ?? `exit code ${result.exitCode}`);
        return {
          summary: `[adapter failure] ${agent.name} as ${request.role}: ${reason}`,
          outcome: "abort",
          costCents,
          metadata: {
            live: true,
            adapterType,
            adapterFailure: true,
            exitCode: result.exitCode ?? null,
          },
        };
      }

      // WC-210 (finding D / same bug WC-207 fixed for deliberation): parse the
      // adapter's CLEAN assistant TEXT (result.summary), NOT raw stdout. For
      // stream-json adapters (claude-local) stdout is the NDJSON protocol stream
      // (hook/init/result events), so feeding it to parsePairTurnResponse made
      // the pair "summary" protocol garbage and the OUTCOME marker undetectable.
      // claude-local sets result.summary to the final assistant text
      // (parsedStream.summary || result.result); codex-local likewise. An adapter
      // that produced no summary → "" → parse yields an empty "(no output)"
      // delivered turn, the same safe degrade as before.
      const parsed = parsePairTurnResponse(result.summary ?? "");
      return {
        summary: parsed.summary.length > 0 ? parsed.summary : "(no output)",
        outcome: parsed.outcome,
        costCents,
        metadata: { live: true, adapterType },
      };
    } catch (err) {
      // Never let an adapter exception bubble up as a 500 — convert it into a
      // clean abort so the orchestrator stops the pair gracefully.
      return {
        summary: `[adapter error] ${agent.name} as ${request.role}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        outcome: "abort",
        costCents: 0,
        metadata: { live: true, adapterType, adapterError: true },
      };
    }
  };
}
