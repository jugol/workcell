import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@workcell/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createWorkcellRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"workcell"}\n', "utf8");
  await fs.writeFile(
    path.join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

async function createCustomSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "custom", skillName), { recursive: true });
  await fs.writeFile(
    path.join(root, "custom", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

describe("codex local adapter skill injection", () => {
  const workcellKey = "workcell/workcell/workcell";
  const createAgentKey = "workcell/workcell/workcell-create-agent";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("repairs a Codex Workcell skill symlink that still points at another live checkout", async () => {
    const currentRepo = await makeTempDir("workcell-codex-current-");
    const oldRepo = await makeTempDir("workcell-codex-old-");
    const skillsHome = await makeTempDir("workcell-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createWorkcellRepoSkill(currentRepo, "workcell");
    await createWorkcellRepoSkill(currentRepo, "workcell-create-agent");
    await createWorkcellRepoSkill(oldRepo, "workcell");
    await fs.symlink(path.join(oldRepo, "skills", "workcell"), path.join(skillsHome, "workcell"));

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [
          {
            key: workcellKey,
            runtimeName: "workcell",
            source: path.join(currentRepo, "skills", "workcell"),
          },
          {
            key: createAgentKey,
            runtimeName: "workcell-create-agent",
            source: path.join(currentRepo, "skills", "workcell-create-agent"),
          },
        ],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "workcell"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "workcell")),
    );
    expect(await fs.realpath(path.join(skillsHome, "workcell-create-agent"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "workcell-create-agent")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "workcell"'),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Injected Codex skill "workcell-create-agent"'),
      }),
    );
  });

  it("preserves a custom Codex skill symlink outside Workcell repo checkouts", async () => {
    const currentRepo = await makeTempDir("workcell-codex-current-");
    const customRoot = await makeTempDir("workcell-codex-custom-");
    const skillsHome = await makeTempDir("workcell-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createWorkcellRepoSkill(currentRepo, "workcell");
    await createCustomSkill(customRoot, "workcell");
    await fs.symlink(path.join(customRoot, "custom", "workcell"), path.join(skillsHome, "workcell"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: workcellKey,
        runtimeName: "workcell",
        source: path.join(currentRepo, "skills", "workcell"),
      }],
    });

    expect(await fs.realpath(path.join(skillsHome, "workcell"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "workcell")),
    );
  });

  it("prunes broken symlinks for unavailable Workcell repo skills before Codex starts", async () => {
    const currentRepo = await makeTempDir("workcell-codex-current-");
    const oldRepo = await makeTempDir("workcell-codex-old-");
    const skillsHome = await makeTempDir("workcell-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createWorkcellRepoSkill(currentRepo, "workcell");
    await createWorkcellRepoSkill(oldRepo, "agent-browser");
    const staleTarget = path.join(oldRepo, "skills", "agent-browser");
    await fs.symlink(staleTarget, path.join(skillsHome, "agent-browser"));
    await fs.rm(staleTarget, { recursive: true, force: true });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: workcellKey,
          runtimeName: "workcell",
          source: path.join(currentRepo, "skills", "workcell"),
        }],
      },
    );

    await expect(fs.lstat(path.join(skillsHome, "agent-browser"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Removed stale Codex skill "agent-browser"'),
      }),
    );
  });

  it("preserves other live Workcell skill symlinks in the shared workspace skill directory", async () => {
    const currentRepo = await makeTempDir("workcell-codex-current-");
    const skillsHome = await makeTempDir("workcell-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createWorkcellRepoSkill(currentRepo, "workcell");
    await createWorkcellRepoSkill(currentRepo, "agent-browser");
    await fs.symlink(
      path.join(currentRepo, "skills", "agent-browser"),
      path.join(skillsHome, "agent-browser"),
    );

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: workcellKey,
        runtimeName: "workcell",
        source: path.join(currentRepo, "skills", "workcell"),
      }],
    });

    expect((await fs.lstat(path.join(skillsHome, "workcell"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "agent-browser"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(skillsHome, "agent-browser"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "agent-browser")),
    );
  });
});
