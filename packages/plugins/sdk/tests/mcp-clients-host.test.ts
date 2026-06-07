import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  InvocationScopeDeniedError,
  createHostClientHandlers,
  type HostServices,
} from "../src/host-client-factory.js";
import type { WorkerHostCallContext } from "../src/protocol.js";

// WC-65: the host-side gate for ctx.mcpClients. Construction of the handler
// map only wraps services in closures, so a PARTIAL services mock (just
// mcpClients) is sufficient — the other handlers are never invoked here.
function buildHandlers(
  capabilities: string[],
  mcpClients: Partial<HostServices["mcpClients"]>,
) {
  return createHostClientHandlers({
    pluginId: "test.plugin",
    capabilities: capabilities as never,
    services: { mcpClients } as unknown as HostServices,
  });
}

const scopedCtx: WorkerHostCallContext = { invocationScope: { companyId: "co-1" } };

describe("WC-65 ctx.mcpClients host handlers", () => {
  it("dispatches mcp.callTool to the registry with the company from the TRUSTED invocation scope (not params)", async () => {
    const callTool = vi.fn(async () => ({ text: "ok", isError: false, content: [] }));
    const handlers = buildHandlers(["mcp.client"], { callTool });
    const res = await handlers["mcp.callTool"](
      { mcpKey: "open-design", toolName: "getArtifacts", args: { issueId: "i1" } },
      scopedCtx,
    );
    expect(res).toEqual({ text: "ok", isError: false, content: [] });
    // companyId comes from the invocation scope, NOT from params.
    expect(callTool).toHaveBeenCalledWith({
      companyId: "co-1",
      mcpKey: "open-design",
      toolName: "getArtifacts",
      args: { issueId: "i1" },
    });
  });

  it("denies mcp.callTool without the mcp.client capability and never reaches the registry", async () => {
    const callTool = vi.fn();
    const handlers = buildHandlers([], { callTool });
    await expect(
      handlers["mcp.callTool"]({ mcpKey: "x", toolName: "t" }, scopedCtx),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("refuses a scope-less invocation (no company → cannot resolve a tenant) and never reaches the registry", async () => {
    const callTool = vi.fn();
    const handlers = buildHandlers(["mcp.client"], { callTool });
    await expect(
      handlers["mcp.callTool"]({ mcpKey: "x", toolName: "t" }, {} as WorkerHostCallContext),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("rejects a worker that referenced an invalid invocation scope", async () => {
    const callTool = vi.fn();
    const handlers = buildHandlers(["mcp.client"], { callTool });
    await expect(
      handlers["mcp.callTool"](
        { mcpKey: "x", toolName: "t" },
        { invalidInvocationScope: true } as WorkerHostCallContext,
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("mcp.listTools dispatches with the scoped company and requires the capability", async () => {
    const listTools = vi.fn(async () => [{ name: "getArtifacts" }]);
    const handlers = buildHandlers(["mcp.client"], { listTools });
    const res = await handlers["mcp.listTools"]({ mcpKey: "open-design" }, scopedCtx);
    expect(res).toEqual([{ name: "getArtifacts" }]);
    expect(listTools).toHaveBeenCalledWith({ companyId: "co-1", mcpKey: "open-design" });

    const denied = buildHandlers([], { listTools: vi.fn() });
    await expect(
      denied["mcp.listTools"]({ mcpKey: "x" }, scopedCtx),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});
