import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive, terminateLocalService } from "../services/local-service-supervisor.ts";

// WC: on Windows there is no POSIX process group, so terminating a service by a
// bare pid (process.kill) left its descendants running — orphaned Codex
// subprocesses / embedded-Postgres workers. terminateLocalService now tree-kills
// via `taskkill /T`, so a parent AND its descendants die together. This test
// spawns a real parent->child tree and proves the whole tree is gone.

const spawnedPids = new Set<number>();

function killQuietly(pid: number | null | undefined) {
  if (typeof pid !== "number" || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function waitFor<T>(read: () => T | null, timeoutMs = 3_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value != null) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return read();
}

async function waitForDead(pid: number, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

describe("terminateLocalService process-tree termination", () => {
  afterEach(() => {
    for (const pid of spawnedPids) killQuietly(pid);
    spawnedPids.clear();
  });

  // Windows-only: the POSIX process-group path is exercised by the heartbeat
  // recovery suite. This asserts the win32 taskkill /T tree-kill behavior.
  it.runIf(process.platform === "win32")(
    "tree-kills a service's descendants on Windows, not just the parent pid",
    async () => {
      // Parent spawns a long-lived grandchild, prints its pid, then stays alive.
      const parent = spawn(
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            "process.stdout.write(String(child.pid));",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const parentPid = parent.pid ?? 0;
      expect(parentPid).toBeGreaterThan(0);
      spawnedPids.add(parentPid);

      let stdout = "";
      parent.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });

      const childPid = await waitFor(() => {
        const parsed = Number.parseInt(stdout.trim(), 10);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      });
      if (!childPid) throw new Error(`Failed to capture descendant pid: ${JSON.stringify(stdout)}`);
      spawnedPids.add(childPid);

      // Both alive before termination.
      expect(isPidAlive(parentPid)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);

      // Terminate the SERVICE (parent) — descendants must go with it. The large
      // forceAfterMs is deliberate: on win32 the kill must be FORCE-FIRST (a
      // non-/F taskkill can't signal console processes at all), so the tree must
      // die immediately — NOT after a futile "graceful" wait that would overrun
      // the 10s shutdown drain deadline and leave everything alive on Ctrl+C.
      await terminateLocalService({ pid: parentPid, processGroupId: null }, { forceAfterMs: 10_000 });

      expect(await waitForDead(parentPid, 4_000)).toBe(true);
      // The key assertion: the grandchild is not orphaned — the tree died.
      expect(await waitForDead(childPid, 4_000)).toBe(true);
    },
    15_000,
  );
});
