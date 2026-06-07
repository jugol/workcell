import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { capabilities, capabilityAssignments } from "@workcell/db";
import {
  McpClient,
  type McpClientConfig,
  type McpToolInfo,
  type McpToolResult,
} from "@workcell/mcp-bridge";
import { logger } from "../middleware/logger.js";

// WC-61 (D12/D13): server-side MCP client registry.
//
// Resolves outbound MCP servers from the Capability Registry (WC-27), enforces
// an ACTIVE company-scoped capability assignment before handing out a client,
// caches one connected client per (company, mcpKey), and records call
// telemetry. This is the single gate every server/plugin consumer (KG
// enrichment WC-63, OD plugin via the host RPC WC-65) goes through to reach an
// external MCP server.
//
// SECURITY: authorization is re-checked on EVERY getClient/callTool — not just
// at first connect — so revoking the capability assignment takes effect on the
// next call (the cached connection is reused only while the company still has
// an active company-wide assignment for that server).

// The subset of McpClient the registry depends on. McpClient satisfies this;
// tests inject a fake via the createClient seam so gating/cache/telemetry are
// verified without spawning a real subprocess (the real connect path is
// covered by @workcell/mcp-bridge's own tests).
export interface McpClientLike {
  readonly isConnected: boolean;
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolResult>;
  disconnect(): Promise<void>;
}

export class McpServerNotFoundError extends Error {
  readonly code = "mcp_server_not_found";
  constructor(mcpKey: string) {
    super(`no MCP capability registered for key "${mcpKey}"`);
    this.name = "McpServerNotFoundError";
  }
}

export class McpNotAuthorizedError extends Error {
  readonly code = "mcp_not_authorized";
  constructor(mcpKey: string) {
    super(`company has no active assignment for MCP server "${mcpKey}"`);
    this.name = "McpNotAuthorizedError";
  }
}

export class McpServerMisconfiguredError extends Error {
  readonly code = "mcp_server_misconfigured";
  constructor(mcpKey: string) {
    super(`MCP capability "${mcpKey}" is missing a runnable command in metadata`);
    this.name = "McpServerMisconfiguredError";
  }
}

export interface McpServerTelemetry {
  calls: number;
  failures: number;
  totalLatencyMs: number;
  lastErrorCode: string | null;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Build an McpClientConfig from a capability's metadata bag. The bootstrap
// (WC-64) stores command/serverPath + args + env + cwd here.
function configFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  mcpKey: string,
): McpClientConfig {
  const md = metadata ?? {};
  const command =
    typeof md.command === "string" && md.command.trim().length > 0
      ? md.command
      : typeof md.serverPath === "string" && md.serverPath.trim().length > 0
        ? md.serverPath
        : null;
  if (!command) throw new McpServerMisconfiguredError(mcpKey);
  return {
    command,
    args: asStringArray(md.args),
    env: asStringRecord(md.env),
    cwd: typeof md.cwd === "string" ? md.cwd : undefined,
    timeoutMs: typeof md.timeoutMs === "number" ? md.timeoutMs : undefined,
    connectTimeoutMs:
      typeof md.connectTimeoutMs === "number" ? md.connectTimeoutMs : undefined,
  };
}

export function mcpClientRegistry(
  db: Db,
  options?: { createClient?: (config: McpClientConfig) => McpClientLike },
) {
  const createClient = options?.createClient ?? ((config) => new McpClient(config));
  // Cache the CONNECT PROMISE (not the client) so concurrent first-callers
  // await a single connect instead of double-spawning.
  const cache = new Map<string, Promise<McpClientLike>>();
  const telemetry = new Map<string, McpServerTelemetry>();

  const cacheKey = (companyId: string, mcpKey: string) => `${companyId}::${mcpKey}`;

  function bumpTelemetry(
    key: string,
    patch: { latencyMs?: number; failed?: boolean; errorCode?: string | null },
  ) {
    const cur = telemetry.get(key) ?? {
      calls: 0,
      failures: 0,
      totalLatencyMs: 0,
      lastErrorCode: null,
    };
    cur.calls += 1;
    if (typeof patch.latencyMs === "number") cur.totalLatencyMs += patch.latencyMs;
    if (patch.failed) {
      cur.failures += 1;
      cur.lastErrorCode = patch.errorCode ?? "error";
    }
    telemetry.set(key, cur);
  }

  // Resolve + AUTHORIZE the MCP server for this company. Throws (without
  // spawning anything) when the capability is missing, misconfigured, or has
  // no active company-wide assignment.
  async function resolveAuthorizedConfig(
    companyId: string,
    mcpKey: string,
  ): Promise<McpClientConfig> {
    const cap = await db
      .select()
      .from(capabilities)
      .where(
        and(
          eq(capabilities.companyId, companyId),
          eq(capabilities.key, mcpKey),
          eq(capabilities.sourceKind, "mcp"),
        ),
      )
      .orderBy(desc(capabilities.version), desc(capabilities.createdAt))
      .limit(1)
      .then((rows) => rows[0]);
    if (!cap) throw new McpServerNotFoundError(mcpKey);

    // Require an ACTIVE company-wide (agentId IS NULL) assignment.
    const assignment = await db
      .select({ id: capabilityAssignments.id })
      .from(capabilityAssignments)
      .where(
        and(
          eq(capabilityAssignments.companyId, companyId),
          eq(capabilityAssignments.capabilityId, cap.id),
          isNull(capabilityAssignments.agentId),
          eq(capabilityAssignments.status, "active"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    if (!assignment) throw new McpNotAuthorizedError(mcpKey);

    return configFromMetadata(cap.metadata, mcpKey);
  }

  async function getClient(companyId: string, mcpKey: string): Promise<McpClientLike> {
    // Re-authorize on EVERY call (revocation takes effect promptly).
    const config = await resolveAuthorizedConfig(companyId, mcpKey);
    const key = cacheKey(companyId, mcpKey);

    const existing = cache.get(key);
    if (existing) {
      const client = await existing.catch(() => null);
      if (client && client.isConnected) return client;
      cache.delete(key);
    }

    const promise = (async () => {
      const client = createClient(config);
      await client.connect();
      return client;
    })();
    cache.set(key, promise);
    try {
      return await promise;
    } catch (err) {
      // Never cache a failed connect — the next call retries.
      cache.delete(key);
      throw err;
    }
  }

  async function disconnect(companyId: string, mcpKey: string): Promise<void> {
    const key = cacheKey(companyId, mcpKey);
    const existing = cache.get(key);
    cache.delete(key);
    if (!existing) return;
    const client = await existing.catch(() => null);
    if (client) {
      try {
        await client.disconnect();
      } catch {
        // best effort
      }
    }
  }

  return {
    getClient,
    disconnect,

    disconnectAll: async (): Promise<void> => {
      const entries = Array.from(cache.entries());
      cache.clear();
      await Promise.all(
        entries.map(async ([, p]) => {
          const client = await p.catch(() => null);
          if (client) {
            try {
              await client.disconnect();
            } catch {
              /* best effort */
            }
          }
        }),
      );
    },

    // Instrumented tool call: resolves+authorizes the client, times the call,
    // and records telemetry (a thrown error OR an isError result counts as a
    // failure).
    callTool: async (
      companyId: string,
      mcpKey: string,
      toolName: string,
      args?: Record<string, unknown>,
    ): Promise<McpToolResult> => {
      const key = cacheKey(companyId, mcpKey);
      const startedAt = Date.now();
      try {
        const client = await getClient(companyId, mcpKey);
        const result = await client.callTool(toolName, args);
        bumpTelemetry(key, {
          latencyMs: Date.now() - startedAt,
          failed: result.isError,
          errorCode: result.isError ? "tool_error" : null,
        });
        return result;
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code)
            : "error";
        bumpTelemetry(key, { latencyMs: Date.now() - startedAt, failed: true, errorCode: code });
        logger.warn(
          { companyId, mcpKey, toolName, code },
          "mcp callTool failed",
        );
        throw err;
      }
    },

    getTelemetry: (companyId: string, mcpKey: string): McpServerTelemetry => {
      return (
        telemetry.get(cacheKey(companyId, mcpKey)) ?? {
          calls: 0,
          failures: 0,
          totalLatencyMs: 0,
          lastErrorCode: null,
        }
      );
    },
  };
}

export type McpClientRegistry = ReturnType<typeof mcpClientRegistry>;
