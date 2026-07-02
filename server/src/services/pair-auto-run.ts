import type { Db } from "@workcell/db";
import { pairGroupService } from "./pair-groups.js";
import type { pairRoundOrchestrator } from "./pair-round-orchestrator.js";
import { pairRunRegistry } from "./pair-run-registry.js";

// Pair auto-run ticker: pair groups are AUTO-RUN BY DEFAULT — the heartbeat
// scheduler calls tick() periodically, and each tick advances every
// active+autoRunEnabled group by exactly ONE round via the same orchestrator
// the manual POST /pair-groups/:id/run-round route uses. Users opt out per
// group (PATCH autoRunEnabled=false) to fall back to manual mode.
//
// Safety properties:
//   - The existing stop machinery is untouched and remains the backstop:
//     maxRounds cap, stopPolicy convergence/abort, and actor aborts all fire
//     inside recordTurn/runRound exactly as they do for manual rounds. A group
//     that stops simply drops out of listAutoRunnable (status != active).
//   - One round per group per tick bounds spend per interval.
//   - Per-group in-flight guard via the shared pairRunRegistry: LLM rounds can
//     far outlast the tick interval, so a group whose previous round is still
//     running is skipped (not queued) until that round settles. The registry
//     is shared with the manual run-round route, making manual and auto runs
//     mutually exclusive per group AND letting the UI see both. This is
//     per-GROUP on top of the caller's process-level single-flight guard, so
//     one slow pair never blocks others across ticks.
//   - Each group's round is wrapped in try/catch — one failing group never
//     prevents the remaining groups from running.

export interface PairAutoRunTickResult {
  groupsRun: number;
  errors: Array<{ pairGroupId: string; error: string }>;
}

export interface PairAutoRunTickerOptions {
  // How many groups a single tick may advance (oldest-updated first). Keeps a
  // tick's worst-case LLM spend and wall-clock time bounded. Default 3.
  groupsPerTick?: number;
  logger?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export function pairAutoRunTicker(
  db: Db,
  orchestrator: ReturnType<typeof pairRoundOrchestrator>,
  opts: PairAutoRunTickerOptions = {},
) {
  const svc = pairGroupService(db);
  const groupsPerTick = opts.groupsPerTick ?? 3;

  return {
    tick: async (): Promise<PairAutoRunTickResult> => {
      const result: PairAutoRunTickResult = { groupsRun: 0, errors: [] };
      const candidates = await svc.listAutoRunnable(groupsPerTick);
      for (const group of candidates) {
        // Shared in-flight registry: skip groups whose previous auto round has
        // not settled OR that a manual run-round call is currently driving.
        if (!pairRunRegistry.tryAcquire(group.id, "auto_run")) continue;
        try {
          await orchestrator.runRound({
            companyId: group.companyId,
            pairGroupId: group.id,
          });
          result.groupsRun += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push({ pairGroupId: group.id, error: message });
          opts.logger?.error(
            { pairGroupId: group.id, companyId: group.companyId, err },
            "pair auto-run round failed",
          );
        } finally {
          pairRunRegistry.release(group.id);
        }
      }
      return result;
    },
  };
}
