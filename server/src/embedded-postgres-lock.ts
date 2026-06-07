/**
 * Liveness assessment for the embedded-PostgreSQL `postmaster.pid` lock file.
 *
 * Boot must distinguish a *stale* lock (the postmaster that wrote it is gone —
 * safe to delete so startup can proceed) from a *live* lock (an orphaned
 * postmaster from a prior dirty shutdown is still running and holding the data
 * dir's shared memory). Deleting a live lock is destructive: `pg_ctl stop` needs
 * `postmaster.pid` to locate the cluster, so removing it strands the orphan and
 * escalates a recoverable situation into one needing an elevated kill / reboot.
 *
 * All seams (existsSync / readFileSync / killProbe) are injectable so the
 * orchestration is unit-testable without touching a real data dir or process.
 */
import {
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
} from "node:fs";

export type LockState = "absent" | "stale" | "live";

export interface PostmasterLockAssessment {
  state: LockState;
  /** The PID parsed from the lock file, when one was readable (else null). */
  pid: number | null;
}

type ExistsSyncFn = (path: string) => boolean;
type ReadFileSyncFn = (path: string, encoding: "utf8") => string;
type KillProbeFn = (pid: number, signal: 0) => void;

/**
 * Read the postmaster PID from line 1 of `postmaster.pid` (PostgreSQL writes the
 * postmaster PID as the very first line). Returns null if the file is missing,
 * unreadable, or the first line is not a positive integer.
 */
export function readPostmasterPid(
  pidFilePath: string,
  readFileSync: ReadFileSyncFn = nodeReadFileSync,
): number | null {
  let contents: string;
  try {
    contents = readFileSync(pidFilePath, "utf8");
  } catch {
    return null;
  }
  const firstLine = contents.split("\n")[0]?.trim();
  if (!firstLine) return null;
  const pid = Number(firstLine);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Report whether `pid` belongs to a live process using `process.kill(pid, 0)`
 * semantics (signal 0 performs the permission/existence check without delivering
 * a signal):
 *   - resolves                -> process exists -> alive
 *   - throws with EPERM       -> process exists but we lack permission to signal
 *                                it. THIS is the orphaned-postmaster case (e.g. a
 *                                postmaster owned by another user/elevation), and
 *                                it MUST count as alive — it cannot be inspected,
 *                                and treating it as dead is exactly the data-loss
 *                                bug we are guarding against.
 *   - throws with ESRCH       -> no such process -> dead
 *   - any other throw         -> conservatively treat as alive (better to surface
 *                                an actionable error than to orphan a live one).
 */
export function isProcessAlive(
  pid: number,
  killProbe: KillProbeFn = process.kill,
): boolean {
  try {
    killProbe(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") return false;
    // EPERM (the orphan case) and any unknown error -> alive (conservative).
    return true;
  }
}

/**
 * Classify the `postmaster.pid` lock:
 *   - "absent" — no lock file on disk; nothing to remove.
 *   - "live"   — a PID parsed from the file AND that process is alive. Do NOT
 *                remove the lock; the caller should surface an actionable error.
 *   - "stale"  — file present but either the PID is unreadable/garbage or the
 *                PID is dead. Safe to remove so boot can proceed.
 *
 * Trade-off: the "live" verdict is deliberately conservative (EPERM/unknown ->
 * alive). In the rare event of PID reuse by an unrelated, still-running
 * non-postgres process, we would decline to delete a truly-stale lock and the
 * caller raises an actionable error the user can clear. That is strictly better
 * than the inverse — silently deleting the lock of a live orphaned postmaster,
 * which strands the orphan and corrupts/loses the cluster. We intentionally do
 * NOT shell out to confirm the PID's image name is `postgres`: it would require
 * a platform-specific, non-trivial process query in an otherwise-sync boot path,
 * and the cases that would benefit most (EPERM/unknown) are precisely the ones
 * that cannot be inspected — so they must remain "alive" regardless.
 */
export function assessPostmasterLock(input: {
  pidFilePath: string;
  existsSync?: ExistsSyncFn;
  readFileSync?: ReadFileSyncFn;
  killProbe?: KillProbeFn;
}): PostmasterLockAssessment {
  const existsSync = input.existsSync ?? nodeExistsSync;
  if (!existsSync(input.pidFilePath)) {
    return { state: "absent", pid: null };
  }

  const pid = readPostmasterPid(input.pidFilePath, input.readFileSync);
  if (pid !== null && isProcessAlive(pid, input.killProbe)) {
    return { state: "live", pid };
  }

  // File exists but PID is unreadable/garbage, or the PID is dead -> stale.
  return { state: "stale", pid };
}
