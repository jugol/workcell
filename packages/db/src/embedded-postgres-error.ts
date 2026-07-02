import { readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_RECENT_LOG_LIMIT = 40;
const RECENT_LOG_SUMMARY_LINES = 8;

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(fallbackMessage);
  if (typeof error === "string") return new Error(`${fallbackMessage}: ${error}`);

  try {
    return new Error(`${fallbackMessage}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${fallbackMessage}: ${String(error)}`);
  }
}

function summarizeRecentLogs(recentLogs: string[]): string | null {
  if (recentLogs.length === 0) return null;
  return recentLogs
    .slice(-RECENT_LOG_SUMMARY_LINES)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");
}

function detectEmbeddedPostgresHint(recentLogs: string[]): string | null {
  const haystack = recentLogs.join("\n").toLowerCase();
  if (!haystack.includes("could not create shared memory segment")) {
    return null;
  }

  return (
    "Embedded PostgreSQL bootstrap could not allocate shared memory. " +
    "On macOS, this usually means the host's kern.sysv.shm* limits are too low for another local PostgreSQL cluster. " +
    "Stop other local PostgreSQL servers or raise the shared-memory sysctls, then retry."
  );
}

/**
 * Phrases that mean a PRIOR embedded Postgres process crashed without releasing
 * its data-dir lock (it left a live shared-memory block / a stale postmaster.pid
 * the new normal-privilege start cannot clear). Distinct from the shmget
 * allocation failure above — here a postmaster is/was already attached to this
 * data dir.
 */
const ORPHANED_LOCK_PHRASES = [
  "pre-existing shared memory block is still in use",
  "lock file",
  "is the server already running",
] as const;

function detectOrphanedLock(baseMessage: string, recentLogs: string[]): boolean {
  const haystack = `${baseMessage}\n${recentLogs.join("\n")}`.toLowerCase();
  return ORPHANED_LOCK_PHRASES.some((phrase) => haystack.includes(phrase));
}

/**
 * Best-effort read of the postmaster PID from `<dataDir>/postmaster.pid`. The
 * first line of that file is the postmaster's process id. Any read/parse error
 * is swallowed (the file may be unreadable, gone, or truncated) and yields null.
 */
function defaultReadPostmasterPid(dataDir: string): number | null {
  try {
    const contents = readFileSync(path.resolve(dataDir, "postmaster.pid"), "utf8");
    const firstLine = contents.split(/\r?\n/, 1)[0]?.trim() ?? "";
    const pid = Number.parseInt(firstLine, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function buildOrphanedLockHint(
  dataDir: string,
  pid: number | null,
): string {
  const pidClause =
    pid !== null
      ? `The orphaned postmaster's PID (from ${path.resolve(dataDir, "postmaster.pid")}) is ${pid}. `
      : "";
  return (
    "Embedded PostgreSQL could not start because a prior server process likely orphaned its embedded Postgres: " +
    `a postmaster still holds the lock on the data directory ${path.resolve(dataDir)}. ` +
    pidClause +
    `To recover, terminate that postmaster process${pid !== null ? ` (e.g. kill ${pid})` : ""}, ` +
    "or boot Workcell with a fresh WORKCELL_HOME so it uses a new data directory."
  );
}

export function createEmbeddedPostgresLogBuffer(limit = DEFAULT_RECENT_LOG_LIMIT): {
  append(message: unknown): void;
  getRecentLogs(): string[];
} {
  const recentLogs: string[] = [];

  return {
    append(message: unknown) {
      const text =
        typeof message === "string"
          ? message
          : message instanceof Error
            ? message.message
            : String(message ?? "");

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        recentLogs.push(line);
        if (recentLogs.length > limit) {
          recentLogs.splice(0, recentLogs.length - limit);
        }
      }
    },
    getRecentLogs() {
      return [...recentLogs];
    },
  };
}

export function formatEmbeddedPostgresError(
  error: unknown,
  input: {
    fallbackMessage: string;
    recentLogs?: string[];
    /**
     * The embedded Postgres data directory. When provided AND the failure looks
     * like an orphaned-lock crash, the message is augmented with the data dir,
     * the orphaned postmaster PID (read best-effort from postmaster.pid), and
     * the remediation steps.
     */
    dataDir?: string;
    /**
     * Override the postmaster-PID reader. Defaults to reading the first line of
     * `<dataDir>/postmaster.pid` from disk. Injectable so the orphaned-lock
     * formatting is unit-testable without touching a real data directory.
     */
    readPostmasterPid?: (dataDir: string) => number | null;
  },
): Error {
  const baseError = toError(error, input.fallbackMessage);
  const recentLogs = input.recentLogs ?? [];
  const parts = [baseError.message];
  const hint = detectEmbeddedPostgresHint(recentLogs);
  const recentSummary = summarizeRecentLogs(recentLogs);

  if (hint) {
    parts.push(hint);
  }

  // Orphaned-lock augmentation (a prior crashed server still holding the data-dir
  // lock). Only when we have a data dir to name; with no data dir there is nothing
  // actionable to add, so the message is left unchanged.
  if (input.dataDir && detectOrphanedLock(baseError.message, recentLogs)) {
    const readPid = input.readPostmasterPid ?? defaultReadPostmasterPid;
    const pid = readPid(input.dataDir);
    parts.push(buildOrphanedLockHint(input.dataDir, pid));
  }

  if (recentSummary) {
    parts.push(`Recent embedded Postgres logs: ${recentSummary}`);
  }

  return new Error(parts.join(" "));
}
