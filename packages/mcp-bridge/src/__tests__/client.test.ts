import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../client.js";
import { McpClientError } from "../errors.js";

// Absolute path to the in-repo fake stdio MCP server. We spawn it with the
// SAME node binary that runs the tests (process.execPath) for Windows/PATH
// robustness — no `npx`, no network, no external daemon.
const FAKE_SERVER = fileURLToPath(
  new URL("./fixtures/fake-mcp-server.mjs", import.meta.url),
);

function makeClient(timeoutMs?: number): McpClient {
  return new McpClient({
    command: process.execPath,
    args: [FAKE_SERVER],
    timeoutMs,
  });
}

describe("WC-60 McpClient (outbound stdio MCP)", () => {
  let client: McpClient | null = null;

  afterEach(async () => {
    await client?.disconnect();
    client = null;
  });

  it("connect → listTools → callTool round-trips a known echo tool", async () => {
    client = makeClient();
    await client.connect();
    expect(client.isConnected).toBe(true);

    const tools = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["boom", "echo", "sleep"]);

    const res = await client.callTool("echo", { text: "hello mcp" });
    expect(res.text).toBe("hello mcp");
    expect(res.isError).toBe(false);
  }, 30_000);

  it("surfaces a TOOL-execution error as a result with isError=true (not a throw)", async () => {
    client = makeClient();
    await client.connect();
    const res = await client.callTool("boom", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("boom");
  }, 30_000);

  it("surfaces an unknown tool as an isError result (SDK maps it to a tool error)", async () => {
    client = makeClient();
    await client.connect();
    // The high-level McpServer returns 'tool not found' as a CallToolResult
    // with isError=true (a JSON-RPC -32602), not a transport rejection — so
    // callTool resolves with the error flagged rather than throwing.
    const res = await client.callTool("does_not_exist", {});
    expect(res.isError).toBe(true);
    expect(res.text.toLowerCase()).toContain("not found");
  }, 30_000);

  it("times out a slow tool without leaking the pipe, and the error is sanitized", async () => {
    client = makeClient(150); // 150ms per-call timeout
    await client.connect();
    let thrown: unknown;
    try {
      await client.callTool("sleep", { ms: 2000 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpClientError);
    // SECURITY: the sanitized error must NOT leak the spawned server path.
    const str = (thrown as McpClientError).toString();
    expect(str).not.toContain(FAKE_SERVER);
    expect(str).not.toContain("fake-mcp-server");
    // It still works enough to identify the failing tool by name.
    expect(str).toContain("sleep");
  }, 30_000);

  it("WC-68: connect() is NOT bounded by a tight per-call timeoutMs", async () => {
    // A caller setting a tiny per-call timeout (to bound tool calls) must
    // still be able to connect — connect() uses its own generous timeout,
    // independent of timeoutMs. (Regression: the 150ms timeout test used to
    // flake because connect shared the tight per-call budget.)
    client = makeClient(1); // 1ms per-call budget
    await client.connect();
    expect(client.isConnected).toBe(true);
  }, 30_000);

  it("throws not_connected when calling before connect()", async () => {
    client = makeClient();
    await expect(client.callTool("echo", { text: "x" })).rejects.toMatchObject({
      code: "not_connected",
    });
  });

  it("disconnect closes the child; reconnecting works (no leaked handles)", async () => {
    client = makeClient();
    await client.connect();
    await client.callTool("echo", { text: "first" });
    await client.disconnect();
    expect(client.isConnected).toBe(false);

    // A second connect/call on the same instance must succeed — proves the
    // prior child + stdio pipes were fully torn down.
    await client.connect();
    const res = await client.callTool("echo", { text: "second" });
    expect(res.text).toBe("second");
  }, 30_000);
});
