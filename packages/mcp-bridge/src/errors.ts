// WC-60: outbound MCP client error.
//
// SECURITY: the message must NOT embed the spawned server command / path or
// raw transport internals — those can leak filesystem layout to plugins and
// the UI. Callers identify failures by `code` + the (safe) tool/operation
// name only. The original error is preserved on `cause` for server-side logs
// but is never surfaced in toString().
export type McpClientErrorCode =
  | "connect_failed"
  | "not_connected"
  | "list_tools_failed"
  | "call_tool_failed"
  | "timeout"
  | "mcp_client_error";

export class McpClientError extends Error {
  readonly code: McpClientErrorCode;

  constructor(
    message: string,
    options?: { code?: McpClientErrorCode; cause?: unknown },
  ) {
    super(message);
    this.name = "McpClientError";
    this.code = options?.code ?? "mcp_client_error";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  // Sanitized string form — code + message only, never the cause/command.
  override toString(): string {
    return `${this.name}[${this.code}]: ${this.message}`;
  }
}
