import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { realizePairWorktree } from "../services/pair-workspace.ts";

// D21 (WC-130): the pair-worktree realization seam runs REAL git, so this test
// drives it against a throwaway local git repo (no DB / embedded-pg needed).

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) {
    // Best-effort: detach worktrees first so rm doesn't fight git's locks.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wc130-pairws-"));
  tempDirs.push(dir);
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init"]);
  git(["config", "user.email", "test@workcell.dev"]);
  git(["config", "user.name", "Workcell Test"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, "README.md"), "# repo\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  return dir;
}

const issue = { id: "iss-1", identifier: "WC-1", title: "Pair task", workMode: "standard" };
const agent = { id: "a1", name: "Ada", companyId: "co1" };

describe("WC-130 realizePairWorktree (D21 realization seam)", () => {
  it("creates an isolated git worktree for the pair, distinct from the repo root", async () => {
    const repo = await makeGitRepo();
    const result = await realizePairWorktree({ baseCwd: repo, projectId: null, issue, agent });

    expect(result.created).toBe(true);
    expect(result.branchName).toBeTruthy();
    expect(result.cwd).toBeTruthy();
    // The worktree cwd is a real directory, separate from the repo root.
    expect(path.resolve(result.cwd)).not.toBe(path.resolve(repo));
    await expect(stat(result.cwd)).resolves.toBeTruthy();
    // git itself recognizes it as a linked worktree of the repo. Normalize path
    // separators — git prints forward slashes on Windows, path.resolve backslashes.
    const toFwd = (p: string) => path.resolve(p).replace(/\\/g, "/");
    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).replace(/\\/g, "/");
    expect(worktrees).toContain(toFwd(result.cwd));
  });

  it("reuses the same worktree on a repeated call (idempotent — converges, no duplicate)", async () => {
    const repo = await makeGitRepo();
    const first = await realizePairWorktree({ baseCwd: repo, projectId: null, issue, agent });
    const second = await realizePairWorktree({ baseCwd: repo, projectId: null, issue, agent });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(path.resolve(second.cwd)).toBe(path.resolve(first.cwd));
  });
});
