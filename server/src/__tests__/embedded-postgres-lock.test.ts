import { describe, it, expect } from "vitest";
import {
  assessPostmasterLock,
  isProcessAlive,
  readPostmasterPid,
} from "../embedded-postgres-lock.js";

const PID_FILE = "/fake/data/postmaster.pid";

/** Build a killProbe that throws a Node ErrnoException with the given code. */
function throwingProbe(code: "ESRCH" | "EPERM" | (string & {})) {
  return () => {
    const err = new Error(`mock ${code}`) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  };
}

describe("readPostmasterPid", () => {
  it("parses the PID from line 1 of the file", () => {
    const read = () => "4242\n127.0.0.1\n5432\n";
    expect(readPostmasterPid(PID_FILE, read)).toBe(4242);
  });

  it("returns null when the file is unreadable", () => {
    const read = () => {
      throw new Error("ENOENT");
    };
    expect(readPostmasterPid(PID_FILE, read)).toBeNull();
  });

  it("returns null for a non-numeric / garbage first line", () => {
    expect(readPostmasterPid(PID_FILE, () => "not-a-pid\n")).toBeNull();
    expect(readPostmasterPid(PID_FILE, () => "")).toBeNull();
    expect(readPostmasterPid(PID_FILE, () => "0\n")).toBeNull();
    expect(readPostmasterPid(PID_FILE, () => "-7\n")).toBeNull();
  });
});

describe("isProcessAlive", () => {
  it("returns true when the probe resolves (process exists)", () => {
    expect(isProcessAlive(4242, () => undefined)).toBe(true);
  });

  it("returns false on ESRCH (no such process)", () => {
    expect(isProcessAlive(4242, throwingProbe("ESRCH"))).toBe(false);
  });

  it("returns true on EPERM (orphaned postmaster we cannot signal)", () => {
    expect(isProcessAlive(4242, throwingProbe("EPERM"))).toBe(true);
  });

  it("returns true on an unknown error (conservative)", () => {
    expect(isProcessAlive(4242, throwingProbe("EUNKNOWN"))).toBe(true);
  });
});

describe("assessPostmasterLock", () => {
  it("(a) absent file -> 'absent' and never reads/probes", () => {
    let readCalled = false;
    let probeCalled = false;
    const result = assessPostmasterLock({
      pidFilePath: PID_FILE,
      existsSync: () => false,
      readFileSync: () => {
        readCalled = true;
        return "4242\n";
      },
      killProbe: () => {
        probeCalled = true;
      },
    });
    expect(result).toEqual({ state: "absent", pid: null });
    expect(readCalled).toBe(false);
    expect(probeCalled).toBe(false);
  });

  it("(b) file with a DEAD pid (ESRCH) -> 'stale'", () => {
    const result = assessPostmasterLock({
      pidFilePath: PID_FILE,
      existsSync: () => true,
      readFileSync: () => "4242\n127.0.0.1\n",
      killProbe: throwingProbe("ESRCH"),
    });
    expect(result.state).toBe("stale");
    expect(result.pid).toBe(4242);
  });

  it("(c) file with a LIVE pid -> 'live'", () => {
    const result = assessPostmasterLock({
      pidFilePath: PID_FILE,
      existsSync: () => true,
      readFileSync: () => "4242\n",
      killProbe: () => undefined,
    });
    expect(result.state).toBe("live");
    expect(result.pid).toBe(4242);
  });

  it("(d) EPERM from the probe -> 'live' (the orphan case)", () => {
    const result = assessPostmasterLock({
      pidFilePath: PID_FILE,
      existsSync: () => true,
      readFileSync: () => "4242\n",
      killProbe: throwingProbe("EPERM"),
    });
    expect(result.state).toBe("live");
    expect(result.pid).toBe(4242);
  });

  it("(e) unreadable file -> 'stale' with pid null", () => {
    const result = assessPostmasterLock({
      pidFilePath: PID_FILE,
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("EACCES");
      },
      killProbe: () => undefined,
    });
    expect(result).toEqual({ state: "stale", pid: null });
  });

  it("(e') garbage file contents -> 'stale' with pid null", () => {
    const result = assessPostmasterLock({
      pidFilePath: PID_FILE,
      existsSync: () => true,
      readFileSync: () => "garbage-not-a-pid\n",
      killProbe: () => undefined,
    });
    expect(result).toEqual({ state: "stale", pid: null });
  });

  it("'live' surfaces the PID so the boot error can name it", () => {
    const result = assessPostmasterLock({
      pidFilePath: PID_FILE,
      existsSync: () => true,
      readFileSync: () => "31337\n",
      killProbe: () => undefined,
    });
    expect(result.state).toBe("live");
    expect(result.pid).toBe(31337);
    // The index.ts boot path interpolates result.pid into the actionable error
    // ("...postmaster (PID 31337) is still running and holds <dataDir>...").
    expect(`PID ${result.pid}`).toBe("PID 31337");
  });
});
