import type { Db } from "@workcell/db";
import type { PairTurnExecutor } from "./pair-round-orchestrator.js";
import {
  buildPairTurnExecutor,
  coercePairTurnAdapterConfig,
  stubPairTurnInvoke,
} from "./pair-turn-executors.js";
import { buildRealPairTurnInvoke } from "./pair-turn-real-invoke.js";
import { ensurePairWorkspace } from "./pair-workspace.js";
import { secretService } from "./secrets.js";

// Pair auto-run: the default pair-turn executor wiring, extracted VERBATIM from
// app.ts so the route mount (createApp) and the heartbeat auto-run ticker
// (index.ts) construct the SAME executor instead of drifting apart. Pure
// extraction — no behavior change; the env flags are still read at call time.
//
// WC-33 / WC-58 / WC-146: the real two-model exchange (buildRealPairTurnInvoke)
// is the DEFAULT in normal runtime, so pair collaboration "just works" once a
// local CLI agent (claude/codex) is configured — no env flag needed.
// Determinism is preserved:
//   - under test (VITEST / NODE_ENV=test) it falls back to the deterministic
//     stub so route/orchestrator tests need no LLM/API key, and
//   - WORKCELL_PAIR_LIVE_LLM=0 is an explicit opt-out (e.g. to avoid token
//     spend); WORKCELL_PAIR_LIVE_LLM=1 forces live even under test.
// A live turn that cannot reach a model (no CLI / not logged in) aborts
// gracefully and the round timeline shows the stop reason.
//
// WC-125 (pair env-secret parity): on the live path, resolve the agent's
// adapterConfig env-secret bindings (companyId-scoped) into plain values via
// the same resolver the heartbeat run path uses, so a live pair turn runs with
// the agent's configured credentials. Off the live path the executor keeps the
// safe env-stripping default (stub needs no secrets).
//
// D21 (WC-132): give live pairs a real isolated worktree so the two agents can
// edit files together. Gated behind a SEPARATE flag (WORKCELL_PAIR_LIVE_WORKSPACE)
// on top of the live-LLM flag — text-collaboration pairs need no worktree, and
// worktree creation is a heavier, filesystem side-effecting step. Reuses
// ensurePairWorkspace (resolve repo -> reuse-or-realize -> register); touches
// no lease/JWT machinery.
export function buildDefaultPairTurnExecutor(db: Db): PairTurnExecutor {
  const pairLiveEnv = process.env.WORKCELL_PAIR_LIVE_LLM;
  const pairUnderTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const pairLiveLlm =
    pairLiveEnv === "0"
      ? false
      : pairLiveEnv && pairLiveEnv !== "0"
        ? true
        : !pairUnderTest;
  // db enables real heartbeat_runs records per live pair turn (run lifecycle,
  // log streaming, and a JWT runId that satisfies issues.checkout_run_id's
  // uuid FK — the synthetic string runId used to 500 the checkout route).
  const pairTurnInvoke = pairLiveLlm ? buildRealPairTurnInvoke({ db }) : stubPairTurnInvoke;
  const pairLiveWorkspace =
    pairLiveLlm &&
    Boolean(process.env.WORKCELL_PAIR_LIVE_WORKSPACE) &&
    process.env.WORKCELL_PAIR_LIVE_WORKSPACE !== "0";
  const pairExecutorOptions = pairLiveLlm
    ? {
        resolveAdapterConfig: async (companyId: string, rawAdapterConfig: unknown) => {
          const { config } = await secretService(db).resolveAdapterConfigForRuntime(
            companyId,
            coercePairTurnAdapterConfig(rawAdapterConfig),
          );
          return config;
        },
        ...(pairLiveWorkspace
          ? {
              ensureWorkspace: (
                companyId: string,
                issueId: string,
                agent: { id: string | null; name: string; companyId: string },
                pairGroupId: string,
              ) => ensurePairWorkspace(db, { companyId, issueId, agent, pairGroupId }),
            }
          : {}),
      }
    : undefined;
  return buildPairTurnExecutor(db, pairTurnInvoke, pairExecutorOptions);
}
