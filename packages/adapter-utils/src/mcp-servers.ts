// WC-67 (D12/D13): outbound MCP-server injection for agent CLIs.
//
// An agent can expose MCP servers to its CLI (e.g. the Workcell inbound MCP
// server, an Open Design sidecar) by declaring them in adapterConfig.mcpServers.
// The heartbeat run path extracts them into context.workcellMcpServers; the
// claude/codex adapters serialize them to a generated .mcp.json the CLI reads.
//
// Pure, schema-guarded helpers — no I/O, no throw — so both the server
// (heartbeat) and the adapters can share one definition.

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// Parse an adapterConfig.mcpServers value into McpServerSpec[]. Defensively
// skips malformed entries (missing name/command, wrong types) and never
// throws — a bad spec is ignored, not fatal to the run.
export function extractMcpServersFromConfig(adapterConfig: unknown): McpServerSpec[] {
  if (!adapterConfig || typeof adapterConfig !== "object") return [];
  const raw = (adapterConfig as Record<string, unknown>).mcpServers;
  if (!Array.isArray(raw)) return [];
  const out: McpServerSpec[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const command = typeof e.command === "string" ? e.command.trim() : "";
    if (!name || !command) continue;
    const spec: McpServerSpec = { name, command };
    if (Array.isArray(e.args)) {
      const args = e.args.filter((a): a is string => typeof a === "string");
      if (args.length > 0) spec.args = args;
    }
    if (e.env && typeof e.env === "object" && !Array.isArray(e.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
      if (Object.keys(env).length > 0) spec.env = env;
    }
    out.push(spec);
  }
  return out;
}

// The auto-injected Workcell inbound MCP server spec, pre-filled with the
// WORKCELL_* env an agent run needs to authenticate back to Workcell. Lets an
// agent's CLI call Workcell's own MCP tools (issues, KG, …) during a run.
export function buildWorkcellMcpServerSpec(input: {
  apiUrl: string;
  apiKey?: string | null;
  companyId?: string | null;
  agentId?: string | null;
  runId?: string | null;
}): McpServerSpec {
  const env: Record<string, string> = { WORKCELL_API_URL: input.apiUrl };
  if (input.apiKey) env.WORKCELL_API_KEY = input.apiKey;
  if (input.companyId) env.WORKCELL_COMPANY_ID = input.companyId;
  if (input.agentId) env.WORKCELL_AGENT_ID = input.agentId;
  if (input.runId) env.WORKCELL_RUN_ID = input.runId;
  return { name: "workcell", command: "npx", args: ["-y", "@workcell/mcp-server"], env };
}

export interface McpJsonConfig {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

// Build the `.mcp.json` content Claude Code (and compatible CLIs) read. Later
// specs win on a name collision (so an auto-injected server can be overridden
// by an explicit one of the same name).
export function buildMcpJsonConfig(specs: McpServerSpec[]): McpJsonConfig {
  const mcpServers: McpJsonConfig["mcpServers"] = {};
  for (const spec of specs) {
    mcpServers[spec.name] = {
      command: spec.command,
      ...(spec.args && spec.args.length > 0 ? { args: spec.args } : {}),
      ...(spec.env && Object.keys(spec.env).length > 0 ? { env: spec.env } : {}),
    };
  }
  return { mcpServers };
}

// WC-113: TOML basic strings must escape backslash, double-quote, AND control
// characters (U+0000–U+001F, U+007F). The previous version escaped only `\` and
// `"`, so a control char — most damagingly a newline — in a server name,
// command, arg, or env value emitted a basic string with a raw control char.
// That is INVALID TOML, and because the fragment is appended to
// CODEX_HOME/config.toml the whole file becomes unparseable (Codex then reads no
// config at all for that run). This brings the serializer to parity with the
// `.mcp.json` path, which is already safe because JSON.stringify escapes these.
function tomlString(value: string): string {
  const escaped = value.replace(/[\\"\u0000-\u001F\u007F]/g, (ch) => {
    switch (ch) {
      case "\\": return "\\\\";
      case '"': return '\\"';
      case "\b": return "\\b";
      case "\t": return "\\t";
      case "\n": return "\\n";
      case "\f": return "\\f";
      case "\r": return "\\r";
      default: return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`;
    }
  });
  return `"${escaped}"`;
}

// WC-115: the canonical Codex `config.toml` table key for a server, e.g.
// `mcp_servers."open-design"`. Exported so the WRITER (buildCodexMcpToml) and
// the codex-local de-dupe guard share ONE definition — otherwise a name that
// needs escaping (a quote/control char) would be written escaped but de-duped
// against the raw name, re-injecting a duplicate table that corrupts config.toml.
export function codexMcpServerTableKey(name: string): string {
  return `mcp_servers.${tomlString(name)}`;
}

// WC-69: serialize MCP server specs into Codex `config.toml` [mcp_servers.*]
// tables (Codex reads MCP servers from CODEX_HOME/config.toml, not a .mcp.json).
// The table name is quoted so names with hyphens (e.g. "open-design") are valid
// TOML keys. Returns a TOML fragment intended to be appended to config.toml.
export function buildCodexMcpToml(specs: McpServerSpec[]): string {
  const lines: string[] = [];
  for (const spec of specs) {
    const tableKey = codexMcpServerTableKey(spec.name);
    lines.push(`[${tableKey}]`);
    lines.push(`command = ${tomlString(spec.command)}`);
    if (spec.args && spec.args.length > 0) {
      lines.push(`args = [${spec.args.map(tomlString).join(", ")}]`);
    }
    if (spec.env && Object.keys(spec.env).length > 0) {
      lines.push(`[${tableKey}.env]`);
      for (const [k, v] of Object.entries(spec.env)) {
        lines.push(`${tomlString(k)} = ${tomlString(v)}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// Feature flag: adapter-side .mcp.json injection is OFF unless explicitly
// enabled, so the default agent run path is completely unchanged. The caller
// passes env explicitly (this module stays browser-safe — the root
// adapter-utils entry is imported by the UI, so no `process` reference here).
export function isAdapterMcpInjectionEnabled(env: Record<string, string | undefined>): boolean {
  const v = env.WORKCELL_ADAPTER_MCP_INJECTION;
  return Boolean(v) && v !== "0" && v !== "false";
}
