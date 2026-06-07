import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapDevRunnerWorktreeEnv,
  isLinkedGitWorktreeCheckout,
  resolveWorktreeEnvFilePath,
} from "../dev-runner-worktree.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

describe("dev-runner worktree env bootstrap", () => {
  it("detects linked git worktrees from .git files", () => {
    const root = createTempRoot("workcell-dev-runner-worktree-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/workcell/.git/worktrees/feature\n", "utf8");

    expect(isLinkedGitWorktreeCheckout(root)).toBe(true);
  });

  it("loads repo-local Workcell env for initialized worktrees without overriding explicit env", () => {
    const root = createTempRoot("workcell-dev-runner-worktree-env-");
    fs.mkdirSync(path.join(root, ".workcell"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/workcell/.git/worktrees/feature\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      [
        "WORKCELL_HOME=/tmp/workcell-worktrees",
        "WORKCELL_INSTANCE_ID=feature-worktree",
        "WORKCELL_IN_WORKTREE=true",
        "WORKCELL_WORKTREE_NAME=feature-worktree",
        "WORKCELL_OPTIONAL= # comment-only value",
        "",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      WORKCELL_INSTANCE_ID: "already-set",
    };
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.WORKCELL_HOME).toBe("/tmp/workcell-worktrees");
    expect(env.WORKCELL_INSTANCE_ID).toBe("already-set");
    expect(env.WORKCELL_IN_WORKTREE).toBe("true");
    expect(env.WORKCELL_OPTIONAL).toBe("");
  });

  it("repairs stale migrated config paths before loading worktree env", () => {
    const root = createTempRoot("workcell-dev-runner-worktree-migrated-env-");
    const localConfigPath = path.join(root, ".workcell", "config.json");
    const worktreesDir = path.join(root, ".workcell-worktrees");
    fs.mkdirSync(path.dirname(localConfigPath), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/workcell/.git/worktrees/feature\n", "utf8");
    fs.writeFileSync(localConfigPath, "{}\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      [
        "WORKCELL_HOME=/old/home/.workcell-worktrees",
        "WORKCELL_INSTANCE_ID=feature-worktree",
        "WORKCELL_CONFIG=/old/home/workcell/.workcell/worktrees/feature/.workcell/config.json",
        "WORKCELL_CONTEXT=/old/home/.workcell-worktrees/context.json",
        "WORKCELL_IN_WORKTREE=true",
        "WORKCELL_WORKTREE_NAME=feature-worktree",
        "",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      WORKCELL_WORKTREES_DIR: worktreesDir,
    };
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.WORKCELL_HOME).toBe(worktreesDir);
    expect(env.WORKCELL_CONFIG).toBe(localConfigPath);
    expect(env.WORKCELL_CONTEXT).toBe(path.join(worktreesDir, "context.json"));
    expect(env.WORKCELL_INSTANCE_ID).toBe("feature-worktree");
  });

  it("reports uninitialized linked worktrees so dev runner can fail fast", () => {
    const root = createTempRoot("workcell-dev-runner-worktree-missing-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/workcell/.git/worktrees/feature\n", "utf8");

    expect(bootstrapDevRunnerWorktreeEnv(root, {})).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: true,
    });
  });
});
