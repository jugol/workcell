// WC-60 test fixture: a tiny in-repo stdio MCP SERVER, spawned by the
// McpClient tests via `node fake-mcp-server.mjs`. Built from the SAME
// @modelcontextprotocol/sdk the client uses, so the round-trip is exercised
// against a real MCP transport WITHOUT any external daemon or network.
//
// Plain ESM (.mjs) so `node` can run it directly — the vitest TS loader does
// NOT apply to this spawned child process.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-mcp-server", version: "0.0.0" });

// echo: returns its input text — the happy-path round-trip.
server.tool(
  "echo",
  "Echo the provided text back.",
  { text: z.string() },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

// boom: returns a TOOL-EXECUTION error result (isError:true). This is NOT a
// protocol error — callTool resolves with isError set, it does not reject.
server.tool(
  "boom",
  "Always returns an error result.",
  {},
  async () => ({ content: [{ type: "text", text: "boom" }], isError: true }),
);

// sleep: delays before responding — used to exercise the client-side timeout.
server.tool(
  "sleep",
  "Sleep for ms milliseconds, then respond.",
  { ms: z.number() },
  async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { content: [{ type: "text", text: "awake" }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
