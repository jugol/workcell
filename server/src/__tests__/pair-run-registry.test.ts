import { describe, expect, it } from "vitest";
import { createPairRunRegistry } from "../services/pair-run-registry.ts";

// Pair-round in-flight registry: single-flight guard shared by the manual
// run-round route and the auto-run ticker. Pure in-memory unit — no DB.
describe("pairRunRegistry", () => {
  it("tryAcquire succeeds once, then fails for the same group until released", () => {
    const registry = createPairRunRegistry();

    expect(registry.tryAcquire("group-1", "manual")).toBe(true);
    // Second acquire (any source) must fail while in flight.
    expect(registry.tryAcquire("group-1", "manual")).toBe(false);
    expect(registry.tryAcquire("group-1", "auto_run")).toBe(false);

    registry.release("group-1");
    expect(registry.tryAcquire("group-1", "auto_run")).toBe(true);
  });

  it("a losing tryAcquire does not overwrite the original holder", () => {
    const registry = createPairRunRegistry();
    registry.tryAcquire("group-1", "auto_run");
    expect(registry.tryAcquire("group-1", "manual")).toBe(false);
    expect(registry.get("group-1")?.source).toBe("auto_run");
  });

  it("get exposes source and startedAt while in flight, null otherwise", () => {
    const registry = createPairRunRegistry();
    expect(registry.get("group-1")).toBeNull();

    const before = Date.now();
    registry.tryAcquire("group-1", "auto_run");
    const entry = registry.get("group-1");
    expect(entry?.source).toBe("auto_run");
    expect(entry?.startedAt).toBeInstanceOf(Date);
    expect(entry!.startedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(entry!.startedAt.getTime()).toBeLessThanOrEqual(Date.now());

    registry.release("group-1");
    expect(registry.get("group-1")).toBeNull();
  });

  it("groups are independent: one in-flight group does not block another", () => {
    const registry = createPairRunRegistry();
    expect(registry.tryAcquire("group-1", "manual")).toBe(true);
    expect(registry.tryAcquire("group-2", "auto_run")).toBe(true);
    registry.release("group-1");
    expect(registry.get("group-1")).toBeNull();
    expect(registry.get("group-2")?.source).toBe("auto_run");
  });

  it("release of an unknown group is a no-op", () => {
    const registry = createPairRunRegistry();
    expect(() => registry.release("missing")).not.toThrow();
  });
});
