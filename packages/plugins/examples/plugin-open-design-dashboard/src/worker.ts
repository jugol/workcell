import { definePlugin, runWorker, type PluginContext } from "@workcell/plugin-sdk";

const PLUGIN_NAME = "open-design-dashboard";

// WC-65 capability + WC-61/64 registry key for the Open Design MCP sidecar.
export const OPEN_DESIGN_MCP_KEY = "open-design";
// Per-issue plugin-state key holding the last-fetched artifact snapshot.
export const OPEN_DESIGN_ARTIFACTS_STATE_KEY = "open-design-artifacts";

export interface OpenDesignRefreshResult {
  ok: boolean;
  count: number;
}

// WC-66 (PLAN §9 #4 / D13): pull design artifacts from the Open Design MCP
// sidecar and cache them into plugin state for the dashboard UI to read.
//
// GRACEFUL by design: the Open Design server is operator-configured (WC-64
// registers it pending_approval until a command is set), so in most
// deployments the MCP call is unauthorized/unavailable. Any failure — denied
// capability, missing assignment, transport error, isError result — is
// swallowed; the UI then falls back to the /design-artifacts table route
// (WC-40/47). This never throws.
export async function refreshOpenDesignArtifacts(
  ctx: PluginContext,
  input: { issueId: string },
): Promise<OpenDesignRefreshResult> {
  try {
    const client = ctx.mcpClients.getClient(OPEN_DESIGN_MCP_KEY);
    // companyId is NOT passed here — the host scopes the call to the plugin's
    // invocation company (WC-65). The OD server keys artifacts by issue.
    const result = await client.callTool("getArtifacts", { issueId: input.issueId });
    if (result.isError) {
      ctx.logger.warn(
        `[${PLUGIN_NAME}] getArtifacts returned an error result for issue ${input.issueId}; keeping table fallback`,
      );
      return { ok: false, count: 0 };
    }
    let artifacts: unknown = result.text;
    try {
      artifacts = JSON.parse(result.text);
    } catch {
      // non-JSON payload — store the raw text
    }
    const items = Array.isArray(artifacts)
      ? artifacts
      : artifacts && typeof artifacts === "object" && Array.isArray((artifacts as { items?: unknown }).items)
        ? ((artifacts as { items: unknown[] }).items)
        : [];
    await ctx.state.set(
      { scopeKind: "issue", scopeId: input.issueId, stateKey: OPEN_DESIGN_ARTIFACTS_STATE_KEY },
      { source: "mcp", artifacts },
    );
    return { ok: true, count: items.length };
  } catch (err) {
    ctx.logger.warn(
      `[${PLUGIN_NAME}] Open Design MCP unavailable for issue ${input.issueId}; using table fallback: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { ok: false, count: 0 };
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    // WC-66: acquire the Open Design MCP client handle (a pure proxy — the
    // capability/authorization check happens lazily at callTool time). Real
    // artifact fetches go through refreshOpenDesignArtifacts, which the host
    // (or a future issue-change hook) invokes per issue. If the server isn't
    // configured, calls degrade gracefully to the table route.
    ctx.mcpClients.getClient(OPEN_DESIGN_MCP_KEY);
    ctx.logger.info(
      `${PLUGIN_NAME} plugin setup complete (Open Design MCP client acquired; artifact sync is graceful)`,
    );
  },

  async onHealth() {
    return { status: "ok", message: "Open Design Dashboard ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
