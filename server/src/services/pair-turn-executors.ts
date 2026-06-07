import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { agents, executionWorkspaces, issues } from "@workcell/db";
import type { PairTurnExecutor, PairTurnRequest } from "./pair-round-orchestrator.js";

// WC-33 (P2 §3 driver loop): prompt-aware executor wrapper.
//
// The orchestrator (WC-32) accepts a generic PairTurnExecutor; this module
// builds the prompt-aware layer on top: looks up the agent + issue, builds
// a structured prompt, calls a pluggable `invoke` function with that prompt,
// and parses the response into a PairTurnExecutionResult.
//
// The `invoke` callback is the only thing that varies between integrations:
//   - Production wiring (later slice): invoke = real adapter call via the
//     heartbeat run path. This is non-trivial because of run record
//     management, so it stays factored as a callback for now.
//   - Tests + default app wiring: invoke = a deterministic stub returning
//     a "delivered" summary. This lets the POST /pair-groups/:id/run-round
//     route work end-to-end without an LLM, so callers can validate the
//     orchestration shape before the real adapter integration ships.

export interface PairTurnInvokeContext {
  request: PairTurnRequest;
  promptText: string;
  agent: {
    id: string;
    name: string;
    role: string | null;
    adapter: string | null;
    // WC-97: the agent's configured adapter settings (model selection lives in
    // adapterConfig.model). Optional so existing callers/tests stay valid; the
    // executor always populates it via buildPairTurnAdapterConfig.
    adapterConfig?: Record<string, unknown>;
  };
  issue: {
    id: string;
    title: string | null;
    description: string | null;
  } | null;
  // WC-103: cwd of the issue's existing execution workspace (if one was
  // materialized by a prior run), so a live pair turn can run there and see
  // the repo. Optional — degrades to the process cwd when absent.
  workspaceCwd?: string | null;
}

export interface PairTurnInvokeResult {
  summary: string;
  outcome?: "delivered" | "no_change" | "abort";
  costCents?: number;
  metadata?: Record<string, unknown>;
}

export type PairTurnInvokeFn = (
  ctx: PairTurnInvokeContext,
) => Promise<PairTurnInvokeResult>;

// Build the round prompt from spec-aligned scaffolding. The structure
// matches the D14 grounding map: actor role, current round + cap, the
// counterpart's previous turn summary (if any), and the issue context.
export function buildPairTurnPrompt(input: {
  request: PairTurnRequest;
  issue: { title: string | null; description: string | null } | null;
  agent: { name: string; role: string | null };
  maxRounds: number;
}): string {
  const { request, issue, agent, maxRounds } = input;
  const lines: string[] = [];
  lines.push(
    `You are agent "${agent.name}" (role: ${agent.role ?? "unspecified"}) playing the ${request.role} role in a pair-collaboration round.`,
  );
  lines.push(`This is round ${request.round + 1} of at most ${maxRounds}.`);
  lines.push("");
  if (issue) {
    lines.push("## Issue context");
    lines.push(`- Title: ${issue.title ?? "(no title)"}`);
    if (issue.description) {
      lines.push("- Description:");
      lines.push(issue.description);
    }
    lines.push("");
  }
  if (request.previousTurnSummary) {
    lines.push("## Previous turn (from counterpart)");
    lines.push(request.previousTurnSummary);
    lines.push("");
  }
  lines.push("## Your task");
  if (request.role === "owner") {
    lines.push(
      "Propose the next concrete step toward resolving the issue. Be specific. Stop on a single short paragraph.",
    );
    lines.push("If you cannot make progress, say `OUTCOME: abort` on its own line and briefly explain.");
  } else {
    lines.push(
      "Review the owner's proposal. If you agree with it as-is and have nothing to add, say `OUTCOME: no_change` on its own line.",
    );
    lines.push(
      "Otherwise refine or push back with a concrete counter-proposal in one short paragraph.",
    );
    lines.push("If you believe the work should stop, say `OUTCOME: abort` on its own line.");
  }
  return lines.join("\n");
}

// Parse an LLM response into outcome + summary. Looks for the
// `OUTCOME: <kind>` marker on its own line; falls back to "delivered".
export function parsePairTurnResponse(response: string): {
  summary: string;
  outcome: "delivered" | "no_change" | "abort";
} {
  let outcome: "delivered" | "no_change" | "abort" = "delivered";
  const lines = response.split(/\r?\n/);
  const remaining: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = /^OUTCOME:\s*(delivered|no_change|abort)\b/i.exec(line);
    if (match) {
      outcome = match[1].toLowerCase() as "delivered" | "no_change" | "abort";
      continue;
    }
    remaining.push(rawLine);
  }
  return { summary: remaining.join("\n").trim(), outcome };
}

// Coerce the agent's stored adapterConfig (which may be a JSON string or an
// object) into a plain object, env bindings INCLUDED. Non-objects → {}.
export function coercePairTurnAdapterConfig(raw: unknown): Record<string, unknown> {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

// WC-97 (pair model parity): turn the agent's stored adapterConfig into the
// config a single pair turn runs with. The configured model lives in
// `adapterConfig.model`, which the heartbeat run path passes to the adapter as
// `config` (claude-local: `asString(config.model)`); the prior pair invoker
// hard-passed `{}`, so the agent's model was ignored. We forward the stored
// config but STRIP `env`: forwarding unresolved secret-ref bindings would hand
// the adapter binding objects instead of strings. This is the SAFE default
// (stub + tests + any path without a secret resolver). WC-125: when a real
// resolver is injected (live path), env is RESOLVED instead of stripped — see
// buildPairTurnExecutor's `resolveAdapterConfig` option.
export function buildPairTurnAdapterConfig(raw: unknown): Record<string, unknown> {
  const { env: _env, ...rest } = coercePairTurnAdapterConfig(raw);
  return rest;
}

export interface BuildPairTurnExecutorOptions {
  // WC-125 (pair env-secret parity): when provided, the executor RESOLVES the
  // agent's adapterConfig env-secret bindings (companyId-scoped) into plain
  // values instead of stripping env — so a live pair turn runs with the agent's
  // configured credentials, exactly like the heartbeat run path. The app wires
  // this to secretService.resolveAdapterConfigForRuntime only on the live LLM
  // path; the stub/default keeps the safe env-stripping behavior.
  resolveAdapterConfig?: (
    companyId: string,
    rawAdapterConfig: unknown,
  ) => Promise<Record<string, unknown>>;
  // D21 (WC-132): when provided, the executor REUSES-OR-REALIZES an isolated
  // worktree for the issue so the pair can edit files (not just exchange text).
  // The app wires this to ensurePairWorkspace(db, …) only on the live workspace
  // path; otherwise the executor keeps the WC-103 reuse-ONLY behavior (it never
  // creates a worktree). Returns null when the issue has no project / repo.
  ensureWorkspace?: (
    companyId: string,
    issueId: string,
    agent: { id: string | null; name: string; companyId: string },
    pairGroupId: string,
  ) => Promise<{ cwd: string } | null>;
}

// Build a PairTurnExecutor that resolves agent + issue context, builds the
// prompt, then defers to `invoke` for the actual LLM call.
export function buildPairTurnExecutor(
  db: Db,
  invoke: PairTurnInvokeFn,
  options: BuildPairTurnExecutorOptions = {},
): PairTurnExecutor {
  return async (request) => {
    const agent = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        adapter: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(and(eq(agents.companyId, request.companyId), eq(agents.id, request.actorAgentId)))
      .limit(1)
      .then((rows) => rows[0]);
    if (!agent) {
      throw new Error(`agent ${request.actorAgentId} not found`);
    }

    // WC-59: ground the turn in the issue bound to this pair group. The
    // PairTurnRequest carries only the pairGroupId, but issues.pairGroupId is
    // the back-reference stamped when the group is created (WC-24), so a
    // single tenant-scoped lookup resolves the issue. A missing / mismatched
    // group degrades gracefully to the prior null-issue prompt.
    const issueRow = await db
      .select({
        id: issues.id,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, request.companyId),
          eq(issues.pairGroupId, request.pairGroupId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    const issue: PairTurnInvokeContext["issue"] = issueRow
      ? { id: issueRow.id, title: issueRow.title, description: issueRow.description }
      : null;

    // Resolve the cwd the pair turn runs in.
    //  - WC-103 (default/stub): REUSE an already-materialized workspace only —
    //    no worktree creation. Tenant-scoped, most-recently-used, graceful null.
    //  - D21/WC-132 (live workspace path): when options.ensureWorkspace is wired,
    //    REUSE-OR-REALIZE an isolated worktree so the pair can edit files. Any
    //    failure degrades to null (the round still runs, discussion-only).
    let workspaceCwd: string | null = null;
    if (issueRow && options.ensureWorkspace) {
      const ensured = await options
        .ensureWorkspace(
          request.companyId,
          issueRow.id,
          { id: agent.id, name: agent.name, companyId: request.companyId },
          request.pairGroupId,
        )
        .catch(() => null);
      const cwd = ensured?.cwd?.trim();
      workspaceCwd = cwd && cwd.length > 0 ? cwd : null;
    } else if (issueRow) {
      const workspaceRow = await db
        .select({ cwd: executionWorkspaces.cwd })
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.companyId, request.companyId),
            eq(executionWorkspaces.sourceIssueId, issueRow.id),
            inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
          ),
        )
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt))
        .limit(1)
        .then((rows) => rows[0]);
      const cwd = workspaceRow?.cwd?.trim();
      workspaceCwd = cwd && cwd.length > 0 ? cwd : null;
    }

    const promptText = buildPairTurnPrompt({
      request,
      issue,
      agent: { name: agent.name, role: agent.role },
      // The orchestrator already enforces maxRounds via the group's stop
      // policy; we surface a reasonable default in the prompt copy.
      maxRounds: 10,
    });

    // WC-97: forward configured adapter settings (model). WC-125: on the live
    // path a resolver is injected → env-secret bindings are RESOLVED to plain
    // values (agent runs with its configured credentials); otherwise env is
    // stripped (safe default for the stub + tests). Resolution failures degrade
    // to the stripped config so a misconfigured secret never 500s a round.
    let adapterConfig: Record<string, unknown>;
    if (options.resolveAdapterConfig) {
      try {
        adapterConfig = await options.resolveAdapterConfig(request.companyId, agent.adapterConfig);
      } catch {
        adapterConfig = buildPairTurnAdapterConfig(agent.adapterConfig);
      }
    } else {
      adapterConfig = buildPairTurnAdapterConfig(agent.adapterConfig);
    }

    const invocation = await invoke({
      request,
      promptText,
      agent: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        adapter: agent.adapter,
        adapterConfig,
      },
      issue,
      workspaceCwd,
    });

    return {
      summary: invocation.summary,
      outcome: invocation.outcome,
      costCents: invocation.costCents,
      metadata: invocation.metadata,
    };
  };
}

// Default invoke implementation: deterministic stub that produces a brief
// "delivered" summary. Useful for local dev and for the runner test in
// WC-32. Real LLM-backed invokers should replace this in production.
export const stubPairTurnInvoke: PairTurnInvokeFn = async ({ request, agent }) => {
  return {
    summary: `[stub] ${agent.name} as ${request.role} on round ${request.round + 1}: no live adapter yet.`,
    outcome: "delivered",
    costCents: 0,
    metadata: { stub: true },
  };
};
