import { describe, expect, it, vi } from "vitest";
import { createSingleFlightGuard } from "./single-flight.js";

// Production-readiness Wave 2 (REL — tick re-entrancy guard): the guard backing
// the heartbeat tick. A re-entrant run() while one is in flight must be SKIPPED
// (not queued), invoke onSkip, and the guard must release on settle — including
// after a rejection — so it can never wedge permanently.

describe("createSingleFlightGuard", () => {
  it("skips a re-entrant run while one is in flight and invokes onSkip", async () => {
    const onSkip = vi.fn();
    const guard = createSingleFlightGuard(onSkip);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = vi.fn(() => gate);

    // Start the first run — it blocks on the gate (still in flight).
    const first = guard.run(task);
    expect(guard.inFlight).toBe(true);

    // A second run while the first is in flight is skipped: task NOT called again,
    // onSkip fired, resolves false.
    const skipped = await guard.run(task);
    expect(skipped).toBe(false);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(task).toHaveBeenCalledTimes(1);

    // Let the first finish; it resolves true and releases the guard.
    release();
    await expect(first).resolves.toBe(true);
    expect(guard.inFlight).toBe(false);
  });

  it("releases the guard after the in-flight task rejects (never wedges)", async () => {
    const guard = createSingleFlightGuard();

    await expect(
      guard.run(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    // After a rejection the guard is free again and the next run executes.
    expect(guard.inFlight).toBe(false);
    const task = vi.fn(() => Promise.resolve());
    await expect(guard.run(task)).resolves.toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("allows sequential (non-overlapping) runs to proceed normally", async () => {
    const guard = createSingleFlightGuard();
    const task = vi.fn(() => Promise.resolve());

    await guard.run(task);
    await guard.run(task);
    await guard.run(task);

    expect(task).toHaveBeenCalledTimes(3);
  });
});
