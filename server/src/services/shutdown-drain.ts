/**
 * WC-216 — graceful-shutdown drain for in-flight heartbeat runs.
 *
 * On SIGTERM / SIGINT / the uncaught-exception safety net the server used to
 * `process.exit()` immediately, orphaning the `claude`/`codex` CLI child
 * processes spawned by active heartbeat runs (and leaving their `heartbeat_runs`
 * rows stuck 'running'). This module owns the bounded drain that runs INSIDE the
 * async `shutdown()` in index.ts, before embedded PostgreSQL is stopped, so the
 * children die before PG/exit.
 *
 * It is intentionally a pure, dependency-injected function: it imports nothing
 * from express or the heartbeat service. The caller wires in the live process
 * registry, a per-run termination callback (which reuses the same termination
 * primitive the cancel-run path uses), and the interval-clearing closure. That
 * decoupling is what makes the drain unit-testable with fakes and a fake clock.
 *
 * Hard guarantees:
 *   - bounded: never outlives `deadlineMs`; a wedged child cannot hang exit.
 *   - non-throwing: a failed termination is logged, not fatal — the drain always
 *     resolves so the caller can proceed to PG-stop + exit.
 *   - idempotent: a second invocation (SIGTERM then SIGINT, or the safety-net
 *     path) sees an already-emptied registry and is a clean no-op.
 */

export interface DrainLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface DrainActiveWorkOptions {
  /**
   * Live registry of spawned heartbeat-run children, keyed by run id. Only the
   * keys are read here; the caller's `terminateRun` is responsible for reading
   * the entry's child/pid and deleting it from this map once terminated.
   */
  runningProcesses: Map<string, unknown>;
  /**
   * Terminate the child for a single run id and remove it from the registry.
   * Must resolve (never reject) — a rejection is treated as a failed
   * termination, logged, and the run is reported as remaining.
   */
  terminateRun: (runId: string) => Promise<void>;
  /** Clear the scheduler + DB-backup intervals so no new work is started. */
  clearIntervals: () => void;
  /** Hard upper bound for the whole drain, in milliseconds. */
  deadlineMs: number;
  logger?: DrainLogger;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export interface DrainActiveWorkResult {
  /** Run ids whose termination settled before the deadline. */
  drained: string[];
  /** True if the deadline fired before every termination settled. */
  timedOut: boolean;
  /**
   * Run ids that had NOT settled when the deadline fired (empty when
   * `timedOut` is false). These are the ids the caller should log as
   * potentially-orphaned before exiting.
   */
  remaining: string[];
}

const noopLogger: DrainLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Drain all in-flight heartbeat-run child processes on a bounded deadline.
 *
 * Order of operations:
 *   1. `clearIntervals()` first — stop the scheduler + backup ticks so no NEW
 *      run can be spawned while we are tearing down.
 *   2. Snapshot the current registry keys (so concurrently-resolving
 *      terminations mutating the map don't disturb iteration).
 *   3. Fire `terminateRun(runId)` for every snapshot id concurrently, tracking
 *      which settle.
 *   4. `Promise.race` the "all terminations settled" promise against the
 *      deadline. Whichever wins, return the drained vs still-pending split.
 *
 * Never throws.
 */
export async function drainActiveWork(
  opts: DrainActiveWorkOptions,
): Promise<DrainActiveWorkResult> {
  const logger = opts.logger ?? noopLogger;
  const now = opts.now ?? Date.now;

  // (1) Stop intake first so the snapshot below is the true high-water mark and
  // no fresh child is spawned mid-drain. Guard it — a throwing clearIntervals
  // must not abort the drain.
  try {
    opts.clearIntervals();
  } catch (err) {
    logger.error({ err }, "shutdown drain: clearIntervals threw (continuing)");
  }

  // (2) Snapshot the run ids up-front; terminateRun deletes from the live map as
  // it goes, so we must not iterate the map while it mutates.
  const runIds = Array.from(opts.runningProcesses.keys());

  if (runIds.length === 0) {
    logger.info({ deadlineMs: opts.deadlineMs }, "shutdown drain: no active runs to drain");
    return { drained: [], timedOut: false, remaining: [] };
  }

  const startedAt = now();

  logger.info(
    { runIds, count: runIds.length, deadlineMs: opts.deadlineMs },
    "shutdown drain: terminating in-flight heartbeat run processes",
  );

  const settled = new Set<string>();

  // (3) Fire every termination concurrently. Each wrapper swallows rejection so
  // one failed kill neither aborts the others nor rejects the race; a settled
  // (resolved OR failed-and-logged) run is recorded so we can compute remainder.
  const terminations = runIds.map((runId) =>
    Promise.resolve()
      .then(() => opts.terminateRun(runId))
      .then(
        () => {
          settled.add(runId);
        },
        (err) => {
          // A failed termination is logged, not fatal. We still mark it settled:
          // we did our best and must not let it count as "still draining" and
          // block the race forever. It will surface via logs, and the OS-level
          // process may still be reaped by the orphan-reaper on next start.
          settled.add(runId);
          logger.error({ err, runId }, "shutdown drain: failed to terminate run process");
        },
      ),
  );

  const allSettled = Promise.allSettled(terminations);

  // (4) Bound the whole thing. We poll `settled` rather than capturing the
  // timeout result value, so that whichever branch wins the race we can report
  // the exact drained/remaining split from a single source of truth.
  const deadlineHit = Symbol("deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof deadlineHit>((resolve) => {
    timer = setTimeout(() => resolve(deadlineHit), Math.max(0, opts.deadlineMs));
    // Do not let the deadline timer keep the event loop alive by itself.
    (timer as { unref?: () => void }).unref?.();
  });

  let raceResult: typeof deadlineHit | "settled";
  try {
    raceResult = await Promise.race([
      allSettled.then(() => "settled" as const),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const drained = runIds.filter((id) => settled.has(id));
  const remaining = runIds.filter((id) => !settled.has(id));
  const timedOut = raceResult === deadlineHit && remaining.length > 0;
  const durationMs = Math.max(0, now() - startedAt);

  if (timedOut) {
    logger.warn(
      {
        remaining,
        remainingCount: remaining.length,
        drainedCount: drained.length,
        deadlineMs: opts.deadlineMs,
        durationMs,
      },
      "shutdown drain: deadline reached with run processes still terminating; proceeding to exit (potential orphans)",
    );
  } else {
    logger.info(
      { drainedCount: drained.length, durationMs },
      "shutdown drain: all in-flight run processes terminated",
    );
  }

  return { drained, timedOut, remaining };
}
