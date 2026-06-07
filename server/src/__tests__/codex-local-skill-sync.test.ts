import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCodexSkills,
  syncCodexSkills,
} from "@workcell/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("codex local skill sync", () => {
  const workcellKey = "workcell/workcell/workcell";
  const createAgentKey = "workcell/workcell/workcell-create-agent";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("reports configured Workcell skills for workspace injection on the next run", async () => {
    const codexHome = await makeTempDir("workcell-codex-skill-sync-");
    cleanupDirs.add(codexHome);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        workcellSkillSync: {
          desiredSkills: [workcellKey],
        },
      },
    } as const;

    const before = await listCodexSkills(ctx);
    expect(before.mode).toBe("ephemeral");
    expect(before.desiredSkills).toContain(workcellKey);
    expect(before.desiredSkills).toContain(createAgentKey);
    expect(before.entries.find((entry) => entry.key === workcellKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === workcellKey)?.state).toBe("configured");
    expect(before.entries.find((entry) => entry.key === createAgentKey)?.required).toBe(true);
    expect(before.entries.find((entry) => entry.key === createAgentKey)?.state).toBe("configured");
    expect(before.entries.find((entry) => entry.key === workcellKey)?.detail).toContain("CODEX_HOME/skills/");
  });

  it("does not persist Workcell skills into CODEX_HOME during sync", async () => {
    const codexHome = await makeTempDir("workcell-codex-skill-prune-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        workcellSkillSync: {
          desiredSkills: [workcellKey],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, [workcellKey]);
    expect(after.mode).toBe("ephemeral");
    expect(after.entries.find((entry) => entry.key === workcellKey)?.state).toBe("configured");
    await expect(fs.lstat(path.join(codexHome, "skills", "workcell"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps required bundled Workcell skills configured even when the desired set is emptied", async () => {
    const codexHome = await makeTempDir("workcell-codex-skill-required-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        workcellSkillSync: {
          desiredSkills: [],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, []);
    expect(after.desiredSkills).toContain(workcellKey);
    expect(after.desiredSkills).toContain(createAgentKey);
    expect(after.entries.find((entry) => entry.key === workcellKey)?.state).toBe("configured");
    expect(after.entries.find((entry) => entry.key === createAgentKey)?.state).toBe("configured");
  });

  it("normalizes legacy flat Workcell skill refs before reporting configured state", async () => {
    const codexHome = await makeTempDir("workcell-codex-legacy-skill-sync-");
    cleanupDirs.add(codexHome);

    const snapshot = await listCodexSkills({
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        workcellSkillSync: {
          desiredSkills: ["workcell"],
        },
      },
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toContain(workcellKey);
    expect(snapshot.desiredSkills).not.toContain("workcell");
    expect(snapshot.entries.find((entry) => entry.key === workcellKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === "workcell")).toBeUndefined();
  });
});
