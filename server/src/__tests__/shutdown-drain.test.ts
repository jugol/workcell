import { describe, expect, it, vi } from "vitest";

import { drainActiveWork } from "../services/shutdown-drain.js";

/**
 * WC-216 — graceful-shutdown drain of in-flight heartbeat runs.
 *
 * `drainActiveWork` is a pure, dependency-injected function: the production
 * wiring in index.ts passes the live `runningProcesses` registry, a per-run
 * termination callback (reusing the cancel-run termination primitive), and the
 * interval-clearing closure. These tests exercise it entirely with fakes and
 * small real deadlines so no real timer can hang the suite.
 */

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** A registry whose entry shape is irrelevant to the drain (keys are all it reads). */
function registryOf(...runIds: string[]): Map<string, unknown> {
  return new Map(runIds.map((id) => [id, { child: { pid: 1 }, graceSec: 1, processGroupId: null }]));
}

describe("drainActiveWork", () => {
  it("terminates every tracked run and clears intervals on a normal drain", async () => {
    const runningProcesses = registryOf("run-a", "run-b", "run-c");
    const terminated: string[] = [];
    const clearIntervals = vi.fn();
    const logger = makeLogger();

    const terminateRun = vi.fn(async (runId: string) => {
      terminated.push(runId);
      // Mirror production: terminating a run removes it from the live registry.
      runningProcesses.delete(runId);
    });

    const result = await drainActiveWork({
      runningProcesses,
      terminateRun,
      clearIntervals,
      deadlineMs: 1_000,
      logger,
    });

    // Intervals stopped FIRST (intake halted) before any termination ran.
    expect(clearIntervals).toHaveBeenCalledTimes(1);
    expect(terminateRun).toHaveBeenCalledTimes(3);
    expect(new Set(terminated)).toEqual(new Set(["run-a", "run-b", "run-c"]));

    expect(result.timedOut).toBe(false);
    expect(result.remaining).toEqual([]);
    expect(new Set(result.drained)).toEqual(new Set(["run-a", "run-b", "run-c"]));

    // Registry fully emptied by the terminations.
    expect(runningProcesses.size).toBe(0);
    // No deadline warning on the happy path.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("hits the deadline for a wedged run but still drains the others", async () => {
    const runningProcesses = registryOf("ok-1", "stuck", "ok-2");
    const clearIntervals = vi.fn();
    const logger = makeLogger();

    let resolveStuck: (() => void) | undefined;
    const terminateRun = vi.fn((runId: string) => {
      if (runId === "stuck") {
        // Never settles before the deadline. Capture its resolver so we can
        // release it in the test teardown and avoid a dangling pending promise.
        return new Promise<void>((resolve) => {
          resolveStuck = resolve;
        });
      }
      runningProcesses.delete(runId);
      return Promise.resolve();
    });

    const start = Date.now();
    const result = await drainActiveWork({
      runningProcesses,
      terminateRun,
      clearIntervals,
      deadlineMs: 25, // small real deadline — fires fast, cannot hang the suite
      logger,
    });
    const elapsed = Date.now() - start;

    expect(clearIntervals).toHaveBeenCalledTimes(1);
    expect(result.timedOut).toBe(true);
    expect(result.remaining).toEqual(["stuck"]);
    // The other two drained despite the wedged one.
    expect(new Set(result.drained)).toEqual(new Set(["ok-1", "ok-2"]));
    // The non-stuck runs were removed from the registry; only "stuck" lingers.
    expect(Array.from(runningProcesses.keys())).toEqual(["stuck"]);

    // Bounded: returned within a small multiple of the deadline (not hung).
    expect(elapsed).toBeLessThan(1_000);
    // The deadline path warns with the still-remaining ids.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnPayload = (logger.warn.mock.calls[0]?.[0] ?? {}) as { remaining?: string[] };
    expect(warnPayload.remaining).toEqual(["stuck"]);

    // Release the wedged promise so it doesn't linger past the test.
    resolveStuck?.();
  });

  it("is a clean no-op when the registry is empty", async () => {
    const runningProcesses = new Map<string, unknown>();
    const terminateRun = vi.fn(async () => {});
    const clearIntervals = vi.fn();
    const logger = makeLogger();

    const result = await drainActiveWork({
      runningProcesses,
      terminateRun,
      clearIntervals,
      deadlineMs: 1_000,
      logger,
    });

    // Intake is still stopped even with nothing to drain.
    expect(clearIntervals).toHaveBeenCalledTimes(1);
    expect(terminateRun).not.toHaveBeenCalled();
    expect(result).toEqual({ drained: [], timedOut: false, remaining: [] });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("treats a failed termination as settled (logged, not fatal) and never throws", async () => {
    const runningProcesses = registryOf("good", "bad");
    const clearIntervals = vi.fn();
    const logger = makeLogger();

    const terminateRun = vi.fn(async (runId: string) => {
      if (runId === "bad") throw new Error("kill failed");
      runningProcesses.delete(runId);
    });

    const result = await drainActiveWork({
      runningProcesses,
      terminateRun,
      clearIntervals,
      deadlineMs: 1_000,
      logger,
    });

    // A rejected termination is logged but still counts as drained (best-effort)
    // so it cannot wedge the deadline race.
    expect(result.timedOut).toBe(false);
    expect(new Set(result.drained)).toEqual(new Set(["good", "bad"]));
    expect(result.remaining).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("uses the injected clock without hanging and reports elapsed duration", async () => {
    // A monotonically advancing fake clock proves `now` is injectable; the drain
    // itself still resolves via the (tiny real) deadline / settled terminations.
    let t = 1_000;
    const now = vi.fn(() => (t += 5));
    const runningProcesses = registryOf("r1");
    const terminateRun = vi.fn(async (runId: string) => {
      runningProcesses.delete(runId);
    });

    const result = await drainActiveWork({
      runningProcesses,
      terminateRun,
      clearIntervals: vi.fn(),
      deadlineMs: 1_000,
      now,
      logger: makeLogger(),
    });

    expect(now).toHaveBeenCalled();
    expect(result.drained).toEqual(["r1"]);
    expect(result.timedOut).toBe(false);
  });
});
