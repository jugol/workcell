import type { Db } from "@workcell/db";
import { capabilityService } from "../services/capabilities.js";
import { CODE_GRAPH_MCP_KEY, GRAPH_ENRICHMENT_MCP_KEY } from "../services/knowledge-graph.js";

// WC-64 (D12/D13): register the known outbound MCP servers as Capability rows
// for a company + assign them company-wide, so the MCP client registry (WC-61)
// can resolve them.
//
// The actual server command is operator-configured via env. When it IS set,
// the company-wide assignment is ACTIVE (the registry will spawn it). When
// UNSET (the dev/CI default — there is no real Open Design daemon or graph
// enrichment server here), the capability is still registered for visibility
// but the assignment is PENDING_APPROVAL: the registry refuses to hand out a
// client for an unconfigured server, so consumers (KG enrichment WC-63, the OD
// plugin WC-66) stay safely on their graceful fallback paths until an operator
// configures + approves a real server.
//
// Idempotent: capabilityService.register is idempotent on (company,key,version)
// and assign() is a no-op for an already-active/pending scope, so re-running
// (e.g. per company creation) never duplicates rows. NOTE: because register
// returns the existing row unchanged, changing a server command via env AFTER
// first bootstrap is NOT picked up here — re-point it through the capabilities
// route instead (out of scope for this seed).

export const OPEN_DESIGN_MCP_KEY = "open-design";

interface McpServerSeed {
  key: string;
  name: string;
  description: string;
  commandEnv: string;
  argsEnv: string;
}

const SEEDS: readonly McpServerSeed[] = [
  {
    key: GRAPH_ENRICHMENT_MCP_KEY,
    name: "Knowledge Graph enrichment",
    description:
      "External MCP server that enriches the knowledge graph with code/doc pointers (D12).",
    commandEnv: "WORKCELL_GRAPH_MCP_COMMAND",
    argsEnv: "WORKCELL_GRAPH_MCP_ARGS",
  },
  {
    key: OPEN_DESIGN_MCP_KEY,
    name: "Open Design",
    description:
      "Open Design read-only MCP sidecar for design artifact generation/preview (D13).",
    commandEnv: "WORKCELL_OPEN_DESIGN_MCP_COMMAND",
    argsEnv: "WORKCELL_OPEN_DESIGN_MCP_ARGS",
  },
  {
    // WC-108 (D20): external code-graph engine (e.g. Graphify `python -m
    // graphify.serve`). Read-only; generates/serves the repo code graph that
    // feeds the kind="code" nodes (D12 S1 populator) + query overlay (S3).
    key: CODE_GRAPH_MCP_KEY,
    name: "Code graph engine",
    description:
      "External MCP server that generates/serves the repository code graph (D12/D20, e.g. Graphify).",
    commandEnv: "WORKCELL_CODE_GRAPH_MCP_COMMAND",
    argsEnv: "WORKCELL_CODE_GRAPH_MCP_ARGS",
  },
];

function parseArgs(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const out = parsed.filter((a): a is string => typeof a === "string");
      return out.length > 0 ? out : undefined;
    }
  } catch {
    // not JSON — ignore
  }
  return undefined;
}

export interface RegisteredMcpServer {
  key: string;
  capabilityId: string;
  status: "active" | "pending_approval";
  configured: boolean;
}

export async function registerMcpServers(
  db: Db,
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegisteredMcpServer[]> {
  const caps = capabilityService(db);
  const out: RegisteredMcpServer[] = [];
  for (const seed of SEEDS) {
    const command = env[seed.commandEnv]?.trim();
    const args = parseArgs(env[seed.argsEnv]);
    const metadata: Record<string, unknown> = {};
    if (command) metadata.command = command;
    if (args) metadata.args = args;

    const cap = await caps.register({
      companyId,
      key: seed.key,
      name: seed.name,
      description: seed.description,
      sourceKind: "mcp",
      sourceLocator: command ?? null,
      trustTier: "reviewed",
      metadata,
    });

    // Configured server → active; unconfigured → pending_approval (the
    // registry refuses to spawn it, keeping consumers on their fallback).
    const status: "active" | "pending_approval" = command ? "active" : "pending_approval";
    await caps.assign({
      companyId,
      capabilityId: cap.id,
      agentId: null, // company-wide
      status,
    });

    out.push({ key: seed.key, capabilityId: cap.id, status, configured: Boolean(command) });
  }
  return out;
}
