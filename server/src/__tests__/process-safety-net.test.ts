import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * WC-212 (production-readiness Wave 1, fix #3): the server installs top-level
 * process error handlers so the many fire-and-forget `void fn().then().catch()`
 * tasks can't silently kill the instance.
 *
 *   - unhandledRejection -> log with context, KEEP serving.
 *   - uncaughtException  -> log, attempt graceful shutdown on a bounded
 *     deadline, then exit non-zero.
 *
 * registerProcessSafetyNetHandlers() is module-guarded (idempotent), so within
 * this isolated test file the FIRST call wins and captures our shutdown spy.
 * startServer() needs a full database, so this exercises the registration
 * function directly — a registered-handlers smoke assertion per the plan.
 * Process-global listeners installed here are removed in afterAll.
 */

vi.mock("../middleware/logger.js", () => {
  const makeLogger = (): any => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => makeLogger()),
  });
  return { logger: makeLogger(), httpLogger: vi.fn() };
});

const {
  registerProcessSafetyNetHandlers,
  hasProcessSafetyNetHandlers,
  PROCESS_SAFETY_NET_EVENTS,
} = await import("../index.js");
const { logger } = await import("../middleware/logger.js");

// A persistent shutdown spy (NOT cleared between tests) captured by the single
// real registration below.
const shutdown = vi.fn(async (_reason: string, _exitCode: number) => undefined);

let baselineListeners: Record<string, Function[]>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let firstRegistrationResult = false;
// The exact listeners our registration added, captured so tests can invoke
// only ours directly (rather than process.emit, which would also fire vitest's
// own uncaughtException listener and abort the run).
const addedListeners: Record<string, Function[]> = {};

beforeAll(() => {
  baselineListeners = {};
  for (const event of PROCESS_SAFETY_NET_EVENTS) {
    baselineListeners[event] = process.listeners(event).slice();
  }
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((() => undefined) as unknown) as never);
  firstRegistrationResult = registerProcessSafetyNetHandlers(shutdown, {
    shutdownDeadlineMs: 50,
  });
  for (const event of PROCESS_SAFETY_NET_EVENTS) {
    addedListeners[event] = process
      .listeners(event)
      .filter((listener) => !baselineListeners[event].includes(listener));
  }
});

afterAll(() => {
  for (const event of PROCESS_SAFETY_NET_EVENTS) {
    for (const listener of process.listeners(event)) {
      if (!baselineListeners[event].includes(listener)) {
        process.removeListener(event, listener as (...args: any[]) => void);
      }
    }
  }
  exitSpy.mockRestore();
});

describe("process safety-net handlers", () => {
  it("registers both unhandledRejection and uncaughtException handlers", () => {
    expect(firstRegistrationResult).toBe(true);
    for (const event of PROCESS_SAFETY_NET_EVENTS) {
      expect(process.listenerCount(event)).toBeGreaterThan(0);
    }
    expect(hasProcessSafetyNetHandlers()).toBe(true);
  });

  it("is idempotent — a second call does not register or stack handlers", () => {
    const before = PROCESS_SAFETY_NET_EVENTS.map((e) => process.listenerCount(e));
    const second = registerProcessSafetyNetHandlers(vi.fn(async () => undefined));
    const after = PROCESS_SAFETY_NET_EVENTS.map((e) => process.listenerCount(e));
    expect(second).toBe(false);
    expect(after).toEqual(before);
  });

  it("unhandledRejection logs with context and keeps serving (no exit, no shutdown)", () => {
    (logger.error as any).mockClear();
    exitSpy.mockClear();
    shutdown.mockClear();

    const err = new Error("dropped promise");
    const p = Promise.resolve();
    for (const h of addedListeners.unhandledRejection) {
      (h as (reason: unknown, promise: Promise<unknown>) => void)(err, p);
    }

    const loggedWithErr = (logger.error as any).mock.calls.some(
      (call: any[]) => call[0] && call[0].err === err,
    );
    expect(loggedWithErr).toBe(true);
    // Must NOT take the instance down and must NOT trigger shutdown.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("uncaughtException logs and invokes graceful shutdown with exit code 1", async () => {
    (logger.error as any).mockClear();
    shutdown.mockClear();

    const boom = new Error("kaboom");
    for (const h of addedListeners.uncaughtException) {
      (h as (err: Error, origin: string) => void)(boom, "uncaughtException");
    }

    const loggedBoom = (logger.error as any).mock.calls.some(
      (call: any[]) => call[0] && call[0].err === boom,
    );
    expect(loggedBoom).toBe(true);

    // The handler attempts a graceful shutdown with a non-zero exit code.
    expect(shutdown).toHaveBeenCalledWith("uncaughtException", 1);

    // Let the shutdown promise chain settle so nothing leaks into later tests.
    await Promise.resolve();
    await Promise.resolve();
  });
});
