import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpClientError } from "./errors.js";
import {
  MCP_CLIENT_DEFAULT_TIMEOUT_MS,
  type McpClientConfig,
  type McpToolInfo,
  type McpToolResult,
} from "./types.js";

// WC-60: a thin, safe wrapper around the MCP SDK's stdio Client.
//
// Lifecycle: connect() spawns the sidecar over stdio, listTools()/callTool()
// issue requests with a bounded timeout, disconnect() tears down both the
// client and the child process (no leaked stdio pipes). All failures are
// normalized to McpClientError with the server command/path stripped out.
export class McpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected = false;
  private readonly config: McpClientConfig;

  constructor(config: McpClientConfig) {
    this.config = config;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.config.env,
        cwd: this.config.cwd,
        // Don't let the child's stderr pollute the host's stderr.
        stderr: "ignore",
      });
      this.client = new Client(
        { name: "workcell-mcp-bridge", version: "0.1.0" },
        { capabilities: {} },
      );
      // WC-68: connect uses its OWN (generous) timeout, NOT the per-call
      // timeoutMs — spawning the child + MCP handshake is slower than a tool
      // call and must not be strangled by a tight per-call budget.
      await this.client.connect(this.transport, { timeout: this.connectTimeout() });
      this.connected = true;
    } catch (err) {
      await this.safeClose();
      // Sanitized: never expose the spawned command/path.
      throw new McpClientError("failed to connect to MCP server", {
        code: "connect_failed",
        cause: err,
      });
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const client = this.requireClient();
    try {
      const res = await client.listTools(undefined, { timeout: this.timeout() });
      return (res.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    } catch (err) {
      throw new McpClientError("listTools failed", {
        code: "list_tools_failed",
        cause: err,
      });
    }
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const client = this.requireClient();
    let raw: { content?: unknown; isError?: boolean };
    try {
      raw = (await client.callTool(
        { name, arguments: args ?? {} },
        undefined,
        { timeout: this.timeout() },
      )) as { content?: unknown; isError?: boolean };
    } catch (err) {
      // Identify the failure by the tool NAME only — never the command/path.
      throw new McpClientError(`tool "${name}" call failed`, {
        code: "call_tool_failed",
        cause: err,
      });
    }
    const content = raw.content ?? [];
    return {
      text: extractText(content),
      isError: Boolean(raw.isError),
      content,
    };
  }

  async disconnect(): Promise<void> {
    await this.safeClose();
    this.connected = false;
  }

  private requireClient(): Client {
    if (!this.client || !this.connected) {
      throw new McpClientError("MCP client is not connected", {
        code: "not_connected",
      });
    }
    return this.client;
  }

  private timeout(): number {
    return this.config.timeoutMs ?? MCP_CLIENT_DEFAULT_TIMEOUT_MS;
  }

  // WC-68: connect() timeout, independent of the per-call timeoutMs.
  private connectTimeout(): number {
    return this.config.connectTimeoutMs ?? MCP_CLIENT_DEFAULT_TIMEOUT_MS;
  }

  private async safeClose(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore — best effort teardown
    }
    try {
      await this.transport?.close();
    } catch {
      // ignore — best effort teardown
    }
    this.client = null;
    this.transport = null;
  }
}

// Concatenate the text from MCP text content blocks; ignore non-text blocks.
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}
