/**
 * Production-readiness Wave 2 (REL — tick re-entrancy guard).
 *
 * A tiny single-flight guard for periodic `setInterval` work. The heartbeat tick
 * fans out several reconcilers; under load one tick can outlast the interval, and
 * without a guard the next tick starts while the previous is still running, so
 * concurrent recovery passes race (e.g. read-then-insert dedup double-creates
 * escalation issues). `createSingleFlightGuard` makes ticks non-overlapping: while
 * a run is in flight, further `run()` calls are skipped (invoking `onSkip`) instead
 * of piling on. The guard is released only after the in-flight promise settles, so
 * a rejection can never wedge it permanently.
 *
 * Extracted (vs. an inline boolean) so the skip/in-flight behavior is unit-testable
 * without standing up the full server interval.
 */
export interface SingleFlightGuard {
  /**
   * Run `task` unless a previous invocation is still in flight. When skipped,
   * `onSkip` is invoked (if provided) and `run` resolves immediately without
   * calling `task`. Returns `true` when `task` was started, `false` when skipped.
   */
  run(task: () => Promise<unknown>): Promise<boolean>;
  /** Whether a task is currently in flight (exposed for assertions/diagnostics). */
  readonly inFlight: boolean;
}

export function createSingleFlightGuard(onSkip?: () => void): SingleFlightGuard {
  let inFlight = false;
  return {
    get inFlight() {
      return inFlight;
    },
    async run(task: () => Promise<unknown>): Promise<boolean> {
      if (inFlight) {
        onSkip?.();
        return false;
      }
      inFlight = true;
      try {
        await task();
      } finally {
        inFlight = false;
      }
      return true;
    },
  };
}
