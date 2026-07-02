import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executionWorkspaces, projectWorkspaces } from "@workcell/db";
import {
  planWorktreeSweep,
  sweepLeakedWorktrees,
  type WorktreeDirCandidate,
  type WorktreeSweepDeps,
  type WorktreeSweepLogger,
} from "../services/execution-workspaces.js";

// WC-219 (Item 1): the worktree sweep is SAFETY-FIRST. These tests pin the
// guarantees the design depends on:
//   - `git worktree prune` is always run (git's own GC; never deletes live).
//   - an orphan dir is deleted ONLY when aged past the threshold AND the opt-in
//     delete flag is on; otherwise it is logged, never removed.
//   - a referenced or git-registered dir, or a young orphan, is never touched.
// The decision logic (planWorktreeSweep) is pure; the shell (sweepLeakedWorktrees)
// is exercised with injected git/fs deps + a fake db so no real repo is needed.

const HOUR = 60 * 60 * 1000;
const NOW = 1_000 * HOUR; // arbitrary fixed clock

function dir(p: string, mtimeMs: number): WorktreeDirCandidate {
  return { path: path.resolve(p), mtimeMs };
}

describe("planWorktreeSweep (pure)", () => {
  it("deletes an aged, unreferenced orphan when deletion is enabled", () => {
    const orphan = dir("/repo/.workcell/worktrees/leaked", NOW - 48 * HOUR);
    const plan = planWorktreeSweep({
      worktreeDirs: [orphan],
      gitRegisteredPaths: new Set(),
      activeReferencedPaths: new Set(),
      now: NOW,
      maxAgeMs: 24 * HOUR,
      deleteEnabled: true,
    });

    expect(plan.orphanDirs.map((d) => d.path)).toEqual([orphan.path]);
    expect(plan.toDelete.map((d) => d.path)).toEqual([orphan.path]);
    expect(plan.toLog).toEqual([]);
  });

  it("logs but does NOT delete an aged orphan when deletion is disabled", () => {
    const orphan = dir("/repo/.workcell/worktrees/leaked", NOW - 48 * HOUR);
    const plan = planWorktreeSweep({
      worktreeDirs: [orphan],
      gitRegisteredPaths: new Set(),
      activeReferencedPaths: new Set(),
      now: NOW,
      maxAgeMs: 24 * HOUR,
      deleteEnabled: false,
    });

    expect(plan.toDelete).toEqual([]);
    expect(plan.toLog).toEqual([{ dir: orphan, reason: "delete_disabled" }]);
  });

  it("never deletes a young orphan even with deletion enabled", () => {
    const orphan = dir("/repo/.workcell/worktrees/recent", NOW - 1 * HOUR);
    const plan = planWorktreeSweep({
      worktreeDirs: [orphan],
      gitRegisteredPaths: new Set(),
      activeReferencedPaths: new Set(),
      now: NOW,
      maxAgeMs: 24 * HOUR,
      deleteEnabled: true,
    });

    expect(plan.toDelete).toEqual([]);
    expect(plan.toLog).toEqual([{ dir: orphan, reason: "too_young" }]);
  });

  it("never touches a git-registered or active-referenced dir", () => {
    const registered = dir("/repo/.workcell/worktrees/registered", NOW - 99 * HOUR);
    const referenced = dir("/repo/.workcell/worktrees/active-pair", NOW - 99 * HOUR);
    const plan = planWorktreeSweep({
      worktreeDirs: [registered, referenced],
      gitRegisteredPaths: new Set([registered.path]),
      activeReferencedPaths: new Set([referenced.path]),
      now: NOW,
      maxAgeMs: 24 * HOUR,
      deleteEnabled: true,
    });

    // Both are provably in use -> not even orphans.
    expect(plan.orphanDirs).toEqual([]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.toLog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Impure shell with injected git/fs + a fake db.
// ---------------------------------------------------------------------------

interface FakeRows {
  executionWorkspaces: Array<Record<string, unknown>>;
  projectWorkspaces: Array<Record<string, unknown>>;
}

/**
 * Minimal stand-in for the drizzle query builder used by sweepLeakedWorktrees:
 * `db.select(cols).from(table).where(cond)` resolved as an array. Routes by table
 * identity so each select returns the right canned rows.
 */
function makeFakeDb(rows: FakeRows) {
  return {
    select() {
      return {
        from(table: unknown) {
          const data =
            table === executionWorkspaces
              ? rows.executionWorkspaces
              : table === projectWorkspaces
                ? rows.projectWorkspaces
                : [];
          return {
            where: () => Promise.resolve(data),
          };
        },
      };
    },
  };
}

function makeLogger(): { logger: WorktreeSweepLogger; warns: Array<[Record<string, unknown>, string]> } {
  const warns: Array<[Record<string, unknown>, string]> = [];
  const logger: WorktreeSweepLogger = {
    info: () => {},
    warn: (obj, msg) => warns.push([obj, msg]),
    error: () => {},
  };
  return { logger, warns };
}

function makeDeps(overrides: Partial<WorktreeSweepDeps> & { dirs?: WorktreeDirCandidate[] }): {
  deps: WorktreeSweepDeps;
  pruneRepo: ReturnType<typeof vi.fn>;
  removeDir: ReturnType<typeof vi.fn>;
} {
  const pruneRepo = vi.fn(async () => {});
  const removeDir = vi.fn(async () => {});
  const deps: WorktreeSweepDeps = {
    pruneRepo,
    listRegisteredWorktrees: overrides.listRegisteredWorktrees ?? (async () => []),
    listWorktreeDirs: overrides.listWorktreeDirs ?? (async () => overrides.dirs ?? []),
    removeDir,
    now: overrides.now ?? (() => NOW),
  };
  return { deps, pruneRepo, removeDir };
}

describe("sweepLeakedWorktrees (shell)", () => {
  const repoRoot = path.resolve("/repo");
  const worktreesBase = path.join(repoRoot, ".workcell", "worktrees");

  it("runs git worktree prune for the repo even with no leaked rows", async () => {
    const db = makeFakeDb({
      executionWorkspaces: [],
      projectWorkspaces: [{ cwd: repoRoot }],
    });
    const { logger } = makeLogger();
    const { deps, pruneRepo, removeDir } = makeDeps({ dirs: [] });

    const result = await sweepLeakedWorktrees(db as never, {
      maxAgeMs: 24 * HOUR,
      deleteEnabled: false,
      logger,
      deps,
    });

    expect(pruneRepo).toHaveBeenCalledWith(repoRoot);
    expect(removeDir).not.toHaveBeenCalled();
    expect(result.pruned).toBe(1);
    expect(result.orphans).toBe(0);
  });

  it("deletes an aged, unreferenced orphan when the flag is on", async () => {
    const orphan = dir(path.join(worktreesBase, "leaked"), NOW - 48 * HOUR);
    const db = makeFakeDb({
      executionWorkspaces: [],
      projectWorkspaces: [{ cwd: repoRoot }],
    });
    const { logger } = makeLogger();
    const { deps, removeDir } = makeDeps({ dirs: [orphan] });

    const result = await sweepLeakedWorktrees(db as never, {
      maxAgeMs: 24 * HOUR,
      deleteEnabled: true,
      logger,
      deps,
    });

    expect(removeDir).toHaveBeenCalledWith(orphan.path);
    expect(result.deleted).toBe(1);
    expect(result.orphans).toBe(1);
  });

  it("logs 'would delete' but does NOT remove when the flag is off", async () => {
    const orphan = dir(path.join(worktreesBase, "leaked"), NOW - 48 * HOUR);
    const db = makeFakeDb({
      executionWorkspaces: [],
      projectWorkspaces: [{ cwd: repoRoot }],
    });
    const { logger, warns } = makeLogger();
    const { deps, removeDir } = makeDeps({ dirs: [orphan] });

    const result = await sweepLeakedWorktrees(db as never, {
      maxAgeMs: 24 * HOUR,
      deleteEnabled: false,
      logger,
      deps,
    });

    expect(removeDir).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(result.orphans).toBe(1);
    expect(warns.some(([, msg]) => msg.includes("would delete"))).toBe(true);
  });

  it("never removes a dir referenced by an active (non-terminal) workspace", async () => {
    const activePath = path.join(worktreesBase, "active-pair");
    const orphanDir = dir(activePath, NOW - 99 * HOUR); // old, but referenced
    const db = makeFakeDb({
      executionWorkspaces: [
        {
          cwd: activePath,
          providerRef: activePath,
          status: "active",
          closedAt: null,
        },
      ],
      projectWorkspaces: [],
    });
    const { logger } = makeLogger();
    const { deps, removeDir } = makeDeps({ dirs: [orphanDir] });

    const result = await sweepLeakedWorktrees(db as never, {
      maxAgeMs: 24 * HOUR,
      deleteEnabled: true,
      logger,
      deps,
    });

    expect(removeDir).not.toHaveBeenCalled();
    expect(result.orphans).toBe(0);
  });

  it("ignores rows whose worktree path is NOT under a .workcell/worktrees container", async () => {
    // A malformed/legacy providerRef pointing somewhere arbitrary must never make
    // the sweep enumerate or prune that location. Only convention-shaped dirs are
    // ever considered.
    const stray = path.resolve("/some/other/place/project");
    const listWorktreeDirs = vi.fn(async () => [] as WorktreeDirCandidate[]);
    const db = makeFakeDb({
      executionWorkspaces: [
        { cwd: stray, providerRef: stray, status: "active", closedAt: null },
      ],
      projectWorkspaces: [],
    });
    const { logger } = makeLogger();
    const { deps, pruneRepo, removeDir } = makeDeps({ listWorktreeDirs });

    const result = await sweepLeakedWorktrees(db as never, {
      maxAgeMs: 24 * HOUR,
      deleteEnabled: true,
      logger,
      deps,
    });

    // No repo root derived -> no prune, no enumeration, no deletion.
    expect(pruneRepo).not.toHaveBeenCalled();
    expect(listWorktreeDirs).not.toHaveBeenCalled();
    expect(removeDir).not.toHaveBeenCalled();
    expect(result.pruned).toBe(0);
    expect(result.orphans).toBe(0);
  });

  it("removes an aged orphan from the SAME repo while sparing a sibling active worktree", async () => {
    const activePath = path.join(worktreesBase, "active-pair");
    const leakedPath = path.join(worktreesBase, "leaked");
    const db = makeFakeDb({
      executionWorkspaces: [
        { cwd: activePath, providerRef: activePath, status: "active", closedAt: null },
        // A closed row in the same repo (its dir was already removed on close).
        { cwd: leakedPath, providerRef: leakedPath, status: "closed", closedAt: new Date(NOW) },
      ],
      projectWorkspaces: [],
    });
    const { logger } = makeLogger();
    const { deps, removeDir } = makeDeps({
      dirs: [
        dir(activePath, NOW - 99 * HOUR),
        dir(leakedPath, NOW - 48 * HOUR),
      ],
    });

    const result = await sweepLeakedWorktrees(db as never, {
      maxAgeMs: 24 * HOUR,
      deleteEnabled: true,
      logger,
      deps,
    });

    expect(removeDir).toHaveBeenCalledTimes(1);
    expect(removeDir).toHaveBeenCalledWith(path.resolve(leakedPath));
    expect(removeDir).not.toHaveBeenCalledWith(path.resolve(activePath));
    expect(result.deleted).toBe(1);
  });
});
