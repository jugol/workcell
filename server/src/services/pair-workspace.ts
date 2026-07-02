import { existsSync } from "node:fs";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { executionWorkspaces, issues, projectWorkspaces } from "@workcell/db";
import {
  realizeExecutionWorkspace,
  cleanupExecutionWorkspaceArtifacts,
  type ExecutionWorkspaceAgentRef,
  type ExecutionWorkspaceIssueRef,
} from "./workspace-runtime.js";

// D21 (WC-130, first slice): realize an ISOLATED git worktree for a pair so the
// two agents can edit files together — not just exchange text proposals.
//
// Architecture note (why this is the safe seam): the heartbeat run path realizes
// workspaces via realizeExecutionWorkspace, but wraps it in lease acquisition,
// JWT minting, environment resolution and an execution-target — the "한 묶음"
// bundle the design (D21) warns must not be partially extracted. The crucial
// finding: realizeExecutionWorkspace ITSELF is exported and decoupled from that
// bundle — for a LOCAL git_worktree it only runs `git worktree add` (reusing an
// existing worktree when present) and returns the cwd. A pair turn runs a single
// adapter turn with no Workcell callback, so it needs the worktree (file access)
// but NOT the lease/JWT. This wrapper calls only that decoupled primitive.
//
// Lifecycle: realizeExecutionWorkspace reuses an existing worktree for the same
// branch, so repeated calls for the same pair issue converge on one worktree
// (idempotent). Registering the worktree as an execution_workspace row (for the
// existing close/cleanup flow) + wiring this into the pair executor are the
// follow-up slices; this slice establishes and tests the realization seam.

export interface PairWorktreeResult {
  cwd: string;
  branchName: string | null;
  worktreePath: string | null;
  created: boolean;
  warnings: string[];
}

export async function realizePairWorktree(input: {
  /** The project's primary repo checkout (must be inside a git repo). */
  baseCwd: string;
  projectId: string | null;
  repoRef?: string | null;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  /** Branch name template; defaults to a pair-scoped, issue-scoped branch. */
  branchTemplate?: string;
}): Promise<PairWorktreeResult> {
  const realized = await realizeExecutionWorkspace({
    base: {
      baseCwd: input.baseCwd,
      source: "project_primary",
      projectId: input.projectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: input.repoRef ?? null,
    },
    config: {
      workspaceStrategy: {
        type: "git_worktree",
        branchTemplate: input.branchTemplate ?? "pair-{{issue.identifier}}-{{slug}}",
      },
    },
    issue: input.issue,
    agent: input.agent,
    // No recorder: a pair worktree realization is not part of a heartbeat run's
    // operation log. (The integration slice will attach one once pair turns are
    // run-backed.)
    recorder: null,
  });
  return {
    cwd: realized.cwd,
    branchName: realized.branchName,
    worktreePath: realized.worktreePath,
    created: realized.created,
    warnings: realized.warnings,
  };
}

export interface EnsuredPairWorkspace {
  cwd: string;
  created: boolean;
  executionWorkspaceId: string | null;
}

// D21 (WC-131, slice 2): ensure a pair issue has an isolated workspace its
// agents can edit in. Resolution chain (all tenant-scoped):
//   issue -> projectId -> project_workspaces(isPrimary).cwd  (the repo checkout)
// then either reuse the issue's existing execution_workspace (WC-103 parity) or
// realize a fresh worktree and REGISTER it as an execution_workspace — so the
// WC-103 reuse query finds it next time AND the existing close/cleanup flow can
// tear it down (no leaked worktrees).
//
// Returns null (gracefully, no error) when the issue has no project or the
// project has no primary repo checkout — those pairs stay discussion-only.
// Never touches the lease/JWT machinery (see D21 / WC-130).
export async function ensurePairWorkspace(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agent: ExecutionWorkspaceAgentRef;
    // WC-133: when realizing a NEW worktree, tag it with the pair group that
    // owns it so closePairWorktrees can reap exactly the worktrees this pair
    // created (never a reused one) when the pair finishes.
    pairGroupId?: string | null;
  },
): Promise<EnsuredPairWorkspace | null> {
  const issueRow = await db
    .select({
      projectId: issues.projectId,
      identifier: issues.identifier,
      title: issues.title,
      workMode: issues.workMode,
    })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
    .limit(1)
    .then((rows) => rows[0]);
  if (!issueRow?.projectId) return null; // no project -> no repo -> discussion-only

  // Reuse an existing materialized workspace for this issue (WC-103 parity).
  const existing = await db
    .select({ id: executionWorkspaces.id, cwd: executionWorkspaces.cwd })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.companyId, input.companyId),
        eq(executionWorkspaces.sourceIssueId, input.issueId),
        inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
      ),
    )
    .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt))
    .limit(1)
    .then((rows) => rows[0]);
  const existingCwd = existing?.cwd?.trim();
  // L3 (review): only reuse a registered workspace if its directory still exists
  // on disk. If it was removed out from under us, fall through and realize a
  // fresh worktree — otherwise the adapter would create a plain (non-git)
  // directory at the dead cwd and the pair would "edit files" outside any repo.
  if (existingCwd && existsSync(existingCwd)) {
    return { cwd: existingCwd, created: false, executionWorkspaceId: existing!.id };
  }

  // Resolve the project's primary workspace = the repo checkout to branch from.
  const primaryWs = await db
    .select({ id: projectWorkspaces.id, cwd: projectWorkspaces.cwd, repoRef: projectWorkspaces.repoRef })
    .from(projectWorkspaces)
    .where(
      and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, issueRow.projectId),
        eq(projectWorkspaces.isPrimary, true),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
  const baseCwd = primaryWs?.cwd?.trim();
  if (!baseCwd) return null; // no repo checkout -> discussion-only

  const realized = await realizePairWorktree({
    baseCwd,
    projectId: issueRow.projectId,
    repoRef: primaryWs?.repoRef ?? null,
    issue: {
      id: input.issueId,
      identifier: issueRow.identifier,
      title: issueRow.title,
      workMode: issueRow.workMode,
    },
    agent: input.agent,
  });

  const [registered] = await db
    .insert(executionWorkspaces)
    .values({
      companyId: input.companyId,
      projectId: issueRow.projectId,
      projectWorkspaceId: primaryWs?.id ?? null,
      sourceIssueId: input.issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      providerType: "git_worktree",
      providerRef: realized.worktreePath,
      name: `pair-${issueRow.identifier ?? input.issueId.slice(0, 8)}`,
      status: "active",
      cwd: realized.cwd,
      branchName: realized.branchName,
      // createdByRuntime:true so cleanup also deletes the branch (the reuse path
      // returns early above, so reaching here always means a freshly realized
      // worktree this pair owns). M2 (review): without it the branch leaked.
      metadata: { createdByRuntime: true, ...(input.pairGroupId ? { createdByPairGroupId: input.pairGroupId } : {}) },
    })
    .returning({ id: executionWorkspaces.id });

  return { cwd: realized.cwd, created: realized.created, executionWorkspaceId: registered?.id ?? null };
}

// WC-133 (D21 slice 4): when a pair finishes (completed/aborted), reap the
// worktrees IT created — never a reused/normal workspace (those are untagged).
// Marks the rows closed AND actually removes the git worktree + branch from disk
// via the same cleanup the manual-close route uses. (H1 review: previously this
// only flipped DB columns; nothing ever swept cleanupEligibleAt for pair
// worktrees, so every live pair leaked its worktree dir + branch.) Best-effort +
// per-row isolated: callers wrap this, and a removal failure never blocks the
// pair status transition. Returns the number of worktrees closed.
export async function closePairWorktrees(
  db: Db,
  companyId: string,
  pairGroupId: string,
): Promise<number> {
  const rows = await db
    .update(executionWorkspaces)
    .set({ status: "closed", cleanupEligibleAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(executionWorkspaces.companyId, companyId),
        sql`${executionWorkspaces.metadata} ->> 'createdByPairGroupId' = ${pairGroupId}`,
        inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
      ),
    )
    .returning({
      id: executionWorkspaces.id,
      cwd: executionWorkspaces.cwd,
      providerType: executionWorkspaces.providerType,
      providerRef: executionWorkspaces.providerRef,
      branchName: executionWorkspaces.branchName,
      repoUrl: executionWorkspaces.repoUrl,
      baseRef: executionWorkspaces.baseRef,
      projectId: executionWorkspaces.projectId,
      projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
      sourceIssueId: executionWorkspaces.sourceIssueId,
      metadata: executionWorkspaces.metadata,
    });

  for (const ws of rows) {
    try {
      const projectWorkspace = ws.projectWorkspaceId
        ? await db
            .select({
              cwd: projectWorkspaces.cwd,
              cleanupCommand: projectWorkspaces.cleanupCommand,
            })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.id, ws.projectWorkspaceId),
                eq(projectWorkspaces.companyId, companyId),
              ),
            )
            .then((r) => r[0] ?? null)
        : null;
      await cleanupExecutionWorkspaceArtifacts({ workspace: ws, projectWorkspace, recorder: null });
    } catch {
      // Swallow: the row is already closed + cleanup-eligible, so the manual
      // close flow can retry the filesystem removal later.
    }
  }

  return rows.length;
}
