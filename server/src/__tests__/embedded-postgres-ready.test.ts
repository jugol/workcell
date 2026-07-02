import { describe, expect, it, vi } from "vitest";
import { isEmbeddedPostgresNotReadyError, retryUntilPostgresReady } from "../index.ts";

// Recovering-orphan tolerance for the embedded PostgreSQL boot path: a dirty
// shutdown leaves the postmaster replaying WAL, and the next boot's first admin
// query used to abort the whole server with "the database system is starting up"
// (57P03). These helpers make the boot WAIT for recovery (and let the caller
// take over a wedged orphan when the wait times out).

function pgError(message: string, code?: string): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string };
  if (code) err.code = code;
  return err;
}

describe("isEmbeddedPostgresNotReadyError", () => {
  it("classifies the recovery/startup states as transient", () => {
    expect(
      isEmbeddedPostgresNotReadyError(pgError("the database system is starting up", "57P03")),
    ).toBe(true);
    expect(isEmbeddedPostgresNotReadyError(pgError("the database system is starting up"))).toBe(
      true,
    );
    expect(isEmbeddedPostgresNotReadyError(pgError("the database system is shutting down"))).toBe(
      true,
    );
    expect(isEmbeddedPostgresNotReadyError(pgError("connect ECONNREFUSED 127.0.0.1:54329"))).toBe(
      true,
    );
    expect(isEmbeddedPostgresNotReadyError(pgError("socket hang up", "ECONNRESET"))).toBe(true);
  });

  it("does not classify real failures as transient", () => {
    expect(
      isEmbeddedPostgresNotReadyError(pgError('password authentication failed for user "x"', "28P01")),
    ).toBe(false);
    expect(isEmbeddedPostgresNotReadyError(pgError("relation does not exist", "42P01"))).toBe(false);
    expect(isEmbeddedPostgresNotReadyError(new Error("boom"))).toBe(false);
    expect(isEmbeddedPostgresNotReadyError(null)).toBe(false);
    expect(isEmbeddedPostgresNotReadyError("starting up")).toBe(false);
  });
});

describe("retryUntilPostgresReady", () => {
  it("retries through transient startup errors until the query succeeds", async () => {
    const onWaiting = vi.fn();
    let attempts = 0;
    const result = await retryUntilPostgresReady(
      async () => {
        attempts += 1;
        if (attempts < 3) throw pgError("the database system is starting up", "57P03");
        return "ready";
      },
      { timeoutMs: 2_000, delayMs: 5, onWaiting },
    );
    expect(result).toBe("ready");
    expect(attempts).toBe(3);
    // onWaiting fires once (first transient), not per retry.
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it("rethrows a non-transient error immediately", async () => {
    let attempts = 0;
    await expect(
      retryUntilPostgresReady(
        async () => {
          attempts += 1;
          throw pgError("password authentication failed", "28P01");
        },
        { timeoutMs: 2_000, delayMs: 5 },
      ),
    ).rejects.toThrow("password authentication failed");
    expect(attempts).toBe(1);
  });

  it("gives up with the transient error once the deadline passes (caller then takes over the orphan)", async () => {
    await expect(
      retryUntilPostgresReady(
        async () => {
          throw pgError("the database system is starting up", "57P03");
        },
        { timeoutMs: 40, delayMs: 10 },
      ),
    ).rejects.toThrow("the database system is starting up");
  });
});
