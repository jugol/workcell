import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from "./embedded-postgres-error.js";

describe("formatEmbeddedPostgresError", () => {
  it("adds a shared-memory hint when initdb logs expose the real cause", () => {
    const error = formatEmbeddedPostgresError("Postgres init script exited with code 1.", {
      fallbackMessage: "Failed to initialize embedded PostgreSQL cluster",
      recentLogs: [
        "running bootstrap script ...",
        "FATAL:  could not create shared memory segment: Cannot allocate memory",
        "DETAIL:  Failed system call was shmget(key=123, size=56, 03600).",
      ],
    });

    expect(error.message).toContain("could not allocate shared memory");
    expect(error.message).toContain("kern.sysv.shm");
    expect(error.message).toContain("could not create shared memory segment");
  });

  it("augments an orphaned shared-memory-lock failure with data dir, PID, and remediation", () => {
    // Use path.resolve so the expectation matches the formatter's own resolution
    // on every OS (POSIX-style literals get drive-prefixed + backslashed on Windows).
    const dataDir = path.resolve("home", "user", ".workcell", "instances", "main", "db");
    const error = formatEmbeddedPostgresError("Postgres start script exited with code 1.", {
      fallbackMessage: "Failed to start embedded PostgreSQL on port 54329",
      dataDir,
      // Inject the PID reader so the formatter is exercised without a real data dir.
      readPostmasterPid: () => 48172,
      recentLogs: [
        "LOG:  starting PostgreSQL 16.4",
        "FATAL:  pre-existing shared memory block is still in use",
        "HINT:  Terminate any old server processes associated with data directory.",
      ],
    });

    expect(error.message).toContain(dataDir);
    expect(error.message).toContain(path.resolve(dataDir, "postmaster.pid"));
    expect(error.message).toContain("prior server process likely orphaned its embedded Postgres");
    expect(error.message).toContain("48172");
    expect(error.message).toContain("kill 48172");
    expect(error.message).toContain("fresh WORKCELL_HOME");
    // The original PG log text is preserved.
    expect(error.message).toContain("pre-existing shared memory block is still in use");
  });

  it("still gives remediation when the postmaster.pid PID cannot be read", () => {
    const dataDir = path.resolve("data", "db");
    const error = formatEmbeddedPostgresError("could not start server", {
      fallbackMessage: "Failed to start embedded PostgreSQL on port 54329",
      dataDir,
      readPostmasterPid: () => null,
      recentLogs: ["FATAL:  lock file \"postmaster.pid\" already exists"],
    });

    expect(error.message).toContain(dataDir);
    expect(error.message).toContain("fresh WORKCELL_HOME");
    // No PID available -> no `kill <pid>` clause, no "is N" PID sentence.
    expect(error.message).not.toContain("kill ");
    expect(error.message).not.toMatch(/PID \(from .*\) is/);
  });

  it("leaves an unrelated error unchanged even when a data dir is supplied", () => {
    const error = formatEmbeddedPostgresError("Postgres init script exited with code 1.", {
      fallbackMessage: "Failed to initialize embedded PostgreSQL cluster",
      dataDir: path.resolve("data", "db"),
      readPostmasterPid: () => 99999,
      recentLogs: [
        "running bootstrap script ...",
        "FATAL:  data directory has wrong ownership",
      ],
    });

    expect(error.message).not.toContain("orphaned");
    expect(error.message).not.toContain("WORKCELL_HOME");
    expect(error.message).not.toContain("99999");
    // Unrelated errors keep the base message + the recent-log summary only.
    expect(error.message).toContain("Postgres init script exited with code 1.");
    expect(error.message).toContain("data directory has wrong ownership");
  });

  it("keeps only recent non-empty log lines in the collector", () => {
    const buffer = createEmbeddedPostgresLogBuffer(2);
    buffer.append("line one\n\n");
    buffer.append("line two");
    buffer.append("line three");

    expect(buffer.getRecentLogs()).toEqual(["line two", "line three"]);
  });
});
