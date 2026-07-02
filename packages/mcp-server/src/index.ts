import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WorkcellApiClient } from "./client.js";
import { readConfigFromEnv, type WorkcellMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createWorkcellMcpServer(config: WorkcellMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "workcell",
    version: "0.1.0",
  });

  const client = new WorkcellApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: WorkcellMcpConfig = readConfigFromEnv()) {
  const { server } = createWorkcellMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
