// WC-60 (PLAN §9 #4 / D12, D13): outbound MCP client types.
//
// This package is the ONLY net-new outbound MCP infrastructure (per D13).
// Both the Knowledge Graph enrichment path (D12) and the Open Design plugin
// (D13) reach external MCP servers through the McpClient defined here.

// Stdio transport descriptor for an outbound MCP server. The server is a
// child process spawned as `command [...args]` with `env` / `cwd`.
export interface McpClientConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // Per-call timeout (ms) for listTools / callTool. Default 30s.
  timeoutMs?: number;
  // WC-68: SEPARATE timeout (ms) for connect(). Spawning the sidecar + the
  // MCP initialize handshake is inherently slower than a single tool call, so
  // it must NOT be strangled by a tight per-call timeoutMs (a caller setting
  // timeoutMs: 150 to bound tool calls would otherwise also fail connect on a
  // cold machine). Default 30s; independent of timeoutMs.
  connectTimeoutMs?: number;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolResult {
  // Concatenated text from the result's text content blocks.
  text: string;
  // Whether the SERVER reported a tool-execution error (result.isError).
  // NOTE: this is distinct from a protocol/transport failure, which rejects
  // with an McpClientError instead.
  isError: boolean;
  // Raw content array as returned by the server (for advanced callers).
  content: unknown;
}

export const MCP_CLIENT_DEFAULT_TIMEOUT_MS = 30_000;
