import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { agents, companies, executionWorkspaces, issues } from "@workcell/db";
import { resolvePlanReportLanguageLabel } from "@workcell/shared";
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
  const dualBrain = request.groupKind === "dual_brain";
  const lines: string[] = [];
  if (dualBrain) {
    // One agent, two brains: same identity and credentials on both turns —
    // only the model behind the seat changes. The counterpart seat is the
    // agent's own review brain, not another agent.
    lines.push(
      request.role === "owner"
        ? `You are agent "${agent.name}" (role: ${agent.role ?? "unspecified"}) in a dual-brain self-review round — this turn is your WORK brain.`
        : `You are agent "${agent.name}" (role: ${agent.role ?? "unspecified"}) in a dual-brain self-review round — this turn is your REVIEW brain, running on a different model than the work just delivered.`,
    );
  } else {
    lines.push(
      `You are agent "${agent.name}" (role: ${agent.role ?? "unspecified"}) playing the ${request.role} role in a pair-collaboration round.`,
    );
  }
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
  // Compact round history (oldest first) so the actor sees how the exchange
  // evolved — the emphasized previous-turn section below may repeat the last
  // entry, which is fine: the dedicated section is the one to act on.
  if (request.recentTurns && request.recentTurns.length > 0) {
    lines.push("## Round history (oldest first)");
    for (const turn of request.recentTurns) {
      const summary = (turn.summary ?? "").slice(0, 200);
      lines.push(`- Round ${turn.round + 1} · ${turn.role} (${turn.outcome}): ${summary}`);
    }
    lines.push("");
  }
  // Role-accurate framing of the previous turn: the owner receives the
  // counterpart's REVIEW of its last proposal; the counterpart receives the
  // owner's PROPOSAL for this round.
  if (request.previousTurnSummary) {
    if (request.role === "owner") {
      lines.push(
        dualBrain
          ? "## Your review brain's critique of your previous work"
          : "## Counterpart's review of your previous proposal",
      );
      lines.push(request.previousTurnSummary);
      lines.push("Address this feedback in your next proposal.");
    } else {
      lines.push(
        dualBrain ? "## The work you just delivered (work brain)" : "## Owner's proposal this round",
      );
      lines.push(request.previousTurnSummary);
    }
    lines.push("");
  }
  lines.push("## Your task");
  if (request.role === "owner") {
    // Pairs WORK, they don't just deliberate: the owner runs with full tool
    // access and an authenticated Workcell agent API (JWT), so each turn must
    // advance the issue itself — the old "propose in one short paragraph"
    // wording produced rounds of talk with zero artifacts.
    lines.push(
      "You own this issue. You have full tool access and an authenticated Workcell agent API in this turn. " +
        "ADVANCE the issue concretely NOW — e.g. write or update its plan document, create child issues, " +
        "edit files in the workspace, run commands. Do the work in this turn; do not merely propose it.",
    );
    lines.push(
      dualBrain
        ? "If your review brain's critique above raises issues, address them with actual changes."
        : "If the counterpart's review above raises issues, address them with actual changes.",
    );
    lines.push(
      "Then report what you DID this turn (artifacts created or updated, decisions taken) and what comes next.",
    );
    // Bidirectional sign-off: the other seat may have directly improved the
    // work last round — this seat can end the loop by approving it instead of
    // inventing more work.
    lines.push(
      dualBrain
        ? "If your review brain's latest changes complete the work and nothing material remains, " +
            "say `OUTCOME: no_change` on its own line to sign off — this ends the self-review."
        : "If the counterpart's latest changes complete the work and nothing material remains, " +
            "say `OUTCOME: no_change` on its own line to sign off — this ends the pair.",
    );
    lines.push(
      "If you are genuinely blocked, say `OUTCOME: abort` on its own line and name the blocker and who must unblock it.",
    );
  } else if (dualBrain) {
    // Self-review brain: a DIFFERENT model auditing the same agent's work.
    // The value is the fresh perspective — be adversarial, then fix rather
    // than narrate.
    lines.push(
      "Critically review the work you (as the work brain) just delivered — assume it has flaws and try to find them: " +
        "wrong assumptions, missed requirements, broken or unverified artifacts. Verify claims with your tools " +
        "(documents, issues, files, commands) instead of trusting the report.",
    );
    lines.push(
      "If corrections are needed, MAKE them directly with your tools (you have full tool access and an " +
        "authenticated agent API) and report what you changed.",
    );
    lines.push(
      "Say `OUTCOME: no_change` on its own line ONLY when the delivered work genuinely needs nothing more — " +
        "this signs the work off and ends the self-review.",
    );
    lines.push("If you believe the work should stop, say `OUTCOME: abort` on its own line.");
  } else {
    // Working reviewer, not just a commentator: the counterpart has the same
    // tool access as the owner, so small corrections should be MADE, not
    // merely pointed out — and no_change is reserved for true sign-off.
    lines.push(
      "Review the owner's work above and verify the claimed artifacts where you can (documents, issues, files). " +
        "If corrections are needed and within your reach, MAKE them yourself with your tools " +
        "(you also have full tool access and an authenticated agent API) and report what you changed.",
    );
    lines.push(
      "Say `OUTCOME: no_change` on its own line ONLY when the owner's latest work needs nothing more.",
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
        deliberation: agents.deliberation,
      })
      .from(agents)
      .where(and(eq(agents.companyId, request.companyId), eq(agents.id, request.actorAgentId)))
      .limit(1)
      .then((rows) => rows[0]);
    if (!agent) {
      throw new Error(`agent ${request.actorAgentId} not found`);
    }

    // Dual-brain seat resolution: the WORK brain is the agent itself — the
    // owner turn always runs on the agent's own adapter/model (brainA is a
    // leftover of the standalone deliberation engine and is intentionally
    // ignored here). Only the counterpart (review) turn swaps to brain B,
    // which may pick its own adapter and model (cross-vendor); null/absent
    // fields inherit the agent's own adapterType / configured model.
    const brain =
      request.groupKind === "dual_brain" && request.role === "counterpart"
        ? agent.deliberation?.brainB ?? null
        : null;
    const brainAdapter = brain?.adapter?.trim() ? brain.adapter.trim() : null;
    const brainModel = brain?.model?.trim() ? brain.model.trim() : null;

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

    let promptText = buildPairTurnPrompt({
      request,
      issue,
      agent: { name: agent.name, role: agent.role },
      // The orchestrator already enforces maxRounds via the group's stop
      // policy; we surface a reasonable default in the prompt copy.
      maxRounds: 10,
    });
    // Team report language parity with the heartbeat task prompt: round
    // summaries and the comments a turn writes are user-facing output.
    const reportLanguageLabel = await db
      .select({ planReportLanguage: companies.planReportLanguage })
      .from(companies)
      .where(eq(companies.id, request.companyId))
      .limit(1)
      .then((rows) => resolvePlanReportLanguageLabel(rows[0]?.planReportLanguage))
      .catch(() => null);
    if (reportLanguageLabel) {
      promptText += `

Language directive: write your turn report and all user-facing output (comments, documents, summaries) in ${reportLanguageLabel}. Keep code, identifiers, commands, and the literal OUTCOME marker lines in English as specified.`;
    }

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
        adapter: brainAdapter ?? agent.adapter,
        adapterConfig: brainModel ? { ...adapterConfig, model: brainModel } : adapterConfig,
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
