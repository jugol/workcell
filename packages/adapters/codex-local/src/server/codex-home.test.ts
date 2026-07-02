import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareManagedCodexHome, stripMcpServerTables } from "./codex-home.js";

describe("codex managed home", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a concurrently-created expected auth symlink as success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workcell-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const workcellHome = path.join(root, "workcell-home");
    const managedCodexHome = path.join(
      workcellHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (source, target, type) => {
      await originalSymlink(source, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            WORKCELL_HOME: workcellHome,
            WORKCELL_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).resolves.toBe(managedCodexHome);

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("strips [mcp_servers.*] tables (and their subtables) but keeps everything else", () => {
    const toml = [
      'model = "gpt-5.5"',
      "",
      "[features]",
      "goals = true",
      "",
      "[mcp_servers.figma]",
      'url = "https://mcp.figma.com/mcp"',
      "",
      "[mcp_servers.node_repl]",
      'command = "node_repl.exe"',
      "",
      "[mcp_servers.node_repl.env]",
      'CODEX_HOME = "C:\\\\Users\\\\me\\\\.codex"',
      "",
      "[projects.'C:\\Users\\me']",
      'trust_level = "trusted"',
    ].join("\n");
    const stripped = stripMcpServerTables(toml);
    expect(stripped).not.toContain("mcp_servers");
    expect(stripped).not.toContain("figma");
    expect(stripped).not.toContain("CODEX_HOME");
    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).toContain("[features]");
    expect(stripped).toContain("goals = true");
    expect(stripped).toContain('trust_level = "trusted"');
  });

  it("seeds config.toml without personal MCP servers and self-heals an already-seeded home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workcell-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const workcellHome = path.join(root, "workcell-home");
    const managedCodexHome = path.join(
      workcellHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const env = {
      CODEX_HOME: sharedCodexHome,
      WORKCELL_HOME: workcellHome,
      WORKCELL_INSTANCE_ID: "default",
    };
    const sharedConfig = [
      'model = "gpt-5.5"',
      "",
      "[mcp_servers.figma]",
      'url = "https://mcp.figma.com/mcp"',
      "",
    ].join("\n");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), sharedConfig, "utf8");

    try {
      // Fresh seed: the copy itself is stripped.
      await prepareManagedCodexHome(env, async () => {}, "company-1");
      const seeded = await fs.readFile(path.join(managedCodexHome, "config.toml"), "utf8");
      expect(seeded).toContain('model = "gpt-5.5"');
      expect(seeded).not.toContain("mcp_servers");

      // Pre-fix home (or codex rewrote the file): personal servers are healed
      // away on the next prepare without touching the rest.
      await fs.writeFile(path.join(managedCodexHome, "config.toml"), sharedConfig, "utf8");
      await prepareManagedCodexHome(env, async () => {}, "company-1");
      const healed = await fs.readFile(path.join(managedCodexHome, "config.toml"), "utf8");
      expect(healed).toContain('model = "gpt-5.5"');
      expect(healed).not.toContain("mcp_servers");

      // The shared (personal) home is never mutated.
      expect(await fs.readFile(path.join(sharedCodexHome, "config.toml"), "utf8")).toBe(sharedConfig);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
