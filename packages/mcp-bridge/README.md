# @workcell/mcp-bridge

Outbound **MCP (Model Context Protocol) client** for Workcell — the single
net-new piece of MCP infrastructure called for by D13 (Open Design) and D12
(Knowledge Graph enrichment).

Workcell already ships an *inbound* MCP server (`@workcell/mcp-server`, which
exposes Workcell's API as tools to external agents). This package is the
opposite direction: it lets Workcell **call out** to external MCP servers
(an Open Design sidecar, a graph-enrichment server, …) and invoke their tools.

## API

```ts
import { McpClient } from "@workcell/mcp-bridge";

const client = new McpClient({
  command: "node",
  args: ["/path/to/some-mcp-server.js"],
  env: { SOME_KEY: "..." },
  timeoutMs: 30_000,
});

await client.connect();              // spawns the sidecar over stdio
const tools = await client.listTools();
const result = await client.callTool("getArtifacts", { companyId, issueId });
//   result.text     — concatenated text content
//   result.isError  — server-reported tool error (NOT a transport failure)
//   result.content  — raw content blocks
await client.disconnect();           // tears down the child + stdio pipes
```

## Design notes

- **Transport:** stdio (`@modelcontextprotocol/sdk` `StdioClientTransport`).
- **Errors:** all transport/protocol failures normalize to `McpClientError`.
  Its message + `toString()` are **sanitized** — they never embed the spawned
  server command/path (which would leak filesystem layout to plugins/UI). The
  original error is kept on `cause` for server-side logs only.
- **Tool errors vs failures:** a tool that *returns* an error result resolves
  with `isError: true`; a transport/protocol failure (timeout, disconnect)
  rejects with `McpClientError`.

Consumed by the server-side MCP client registry (`mcpClientRegistry`, WC-61),
which gates access behind an active company-scoped capability assignment.
