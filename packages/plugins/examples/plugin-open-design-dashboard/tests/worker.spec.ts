import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@workcell/plugin-sdk";
import {
  OPEN_DESIGN_ARTIFACTS_STATE_KEY,
  OPEN_DESIGN_MCP_KEY,
  refreshOpenDesignArtifacts,
} from "../src/worker.js";

// Minimal hand-mocked ctx — refreshOpenDesignArtifacts only touches
// mcpClients.getClient(...).callTool, state.set, and logger.warn.
function mockCtx(callTool: (toolName: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const stateSet = vi.fn(async () => {});
  const getClient = vi.fn(() => ({ callTool, listTools: vi.fn() }));
  const ctx = {
    mcpClients: { getClient },
    state: { get: vi.fn(), set: stateSet, delete: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, stateSet, getClient };
}

describe("WC-66 refreshOpenDesignArtifacts", () => {
  it("fetches via the open-design MCP client and caches the artifacts to issue-scoped state", async () => {
    const callTool = vi.fn(async () => ({
      text: JSON.stringify([{ id: "a1" }, { id: "a2" }]),
      isError: false,
      content: [],
    }));
    const { ctx, stateSet, getClient } = mockCtx(callTool);

    const res = await refreshOpenDesignArtifacts(ctx, { issueId: "iss-1" });

    expect(getClient).toHaveBeenCalledWith(OPEN_DESIGN_MCP_KEY);
    // companyId is NOT supplied by the plugin — the host scopes it.
    expect(callTool).toHaveBeenCalledWith("getArtifacts", { issueId: "iss-1" });
    expect(res).toEqual({ ok: true, count: 2 });
    expect(stateSet).toHaveBeenCalledWith(
      { scopeKind: "issue", scopeId: "iss-1", stateKey: OPEN_DESIGN_ARTIFACTS_STATE_KEY },
      { source: "mcp", artifacts: [{ id: "a1" }, { id: "a2" }] },
    );
  });

  it("handles an { items: [...] } payload shape for the count", async () => {
    const callTool = vi.fn(async () => ({
      text: JSON.stringify({ items: [{ id: "a1" }] }),
      isError: false,
      content: [],
    }));
    const { ctx } = mockCtx(callTool);
    const res = await refreshOpenDesignArtifacts(ctx, { issueId: "iss-2" });
    expect(res).toEqual({ ok: true, count: 1 });
  });

  it("does NOT cache and reports not-ok when the tool returns an isError result", async () => {
    const callTool = vi.fn(async () => ({ text: "server exploded", isError: true, content: [] }));
    const { ctx, stateSet } = mockCtx(callTool);
    const res = await refreshOpenDesignArtifacts(ctx, { issueId: "iss-3" });
    expect(res).toEqual({ ok: false, count: 0 });
    expect(stateSet).not.toHaveBeenCalled();
  });

  it("degrades gracefully (no throw) when the MCP call rejects — unconfigured / unauthorized server", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("mcp_not_authorized");
    });
    const { ctx, stateSet } = mockCtx(callTool);
    const res = await refreshOpenDesignArtifacts(ctx, { issueId: "iss-4" });
    expect(res).toEqual({ ok: false, count: 0 });
    expect(stateSet).not.toHaveBeenCalled();
  });
});
