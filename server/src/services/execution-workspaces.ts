import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { executionWorkspaces, issues, projects, projectWorkspaces, workspaceRuntimeServices } from "@workcell/db";
import type {
  ExecutionWorkspace,
  ExecutionWorkspaceSummary,
  ExecutionWorkspaceCloseAction,
  ExecutionWorkspaceCloseGitReadiness,
  ExecutionWorkspaceCloseReadiness,
  ExecutionWorkspaceConfig,
  WorkspaceRuntimeDesiredState,
  WorkspaceRuntimeService,
} from "@workcell/shared";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import {
  listCurrentRuntimeServicesForExecutionWorkspaces,
  listCurrentRuntimeServicesForProjectWorkspaces,
} from "./workspace-runtime-read-model.js";

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
const execFileAsync = promisify(execFile);
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return { ...value };
}

function readDesiredState(value: unknown): WorkspaceRuntimeDesiredState | null {
  return value === "running" || value === "stopped" || value === "manual" ? value : null;
}

function readServiceStates(value: unknown): ExecutionWorkspaceConfig["serviceStates"] {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter(([, state]) =>
    state === "running" || state === "stopped" || state === "manual"
  );
  return entries.length > 0
    ? Object.fromEntries(entries) as ExecutionWorkspaceConfig["serviceStates"]
    : null;
}

async function pathExists(value: string | null | undefined) {
  if (!value) return false;
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function runGit(args: string[], cwd: string) {
  return await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function inspectGitCloseReadiness(workspace: ExecutionWorkspace): Promise<{
  git: ExecutionWorkspaceCloseGitReadiness | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const workspacePath = readNullableString(workspace.providerRef) ?? readNullableString(workspace.cwd);
  const createdByRuntime = workspace.metadata?.createdByRuntime === true;
  const expectsGitInspection =
    workspace.providerType === "git_worktree" ||
    Boolean(workspace.repoUrl || workspace.baseRef || workspace.branchName || workspacePath);

  if (!expectsGitInspection) {
    return { git: null, warnings };
  }

  if (!workspacePath) {
    warnings.push("Workspace has no local path, so Workcell cannot inspect git status before close.");
    return { git: null, warnings };
  }

  if (!(await pathExists(workspacePath))) {
    warnings.push(`Workspace path "${workspacePath}" does not exist, so Workcell cannot inspect git status before close.`);
    return {
      git: {
        repoRoot: null,
        workspacePath,
        branchName: workspace.branchName,
        baseRef: workspace.baseRef,
        hasDirtyTrackedFiles: false,
        hasUntrackedFiles: false,
        dirtyEntryCount: 0,
        untrackedEntryCount: 0,
        aheadCount: null,
        behindCount: null,
        isMergedIntoBase: null,
        createdByRuntime,
      },
      warnings,
    };
  }

  let repoRoot: string | null = null;
  try {
    repoRoot = (await runGit(["rev-parse", "--show-toplevel"], workspacePath)).stdout.trim() || null;
  } catch (error) {
    warnings.push(
      `Could not inspect git status for "${workspacePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let branchName = workspace.branchName;
  if (repoRoot && !branchName) {
    try {
      branchName = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)).stdout.trim() || null;
    } catch {
      branchName = workspace.branchName;
    }
  }

  let dirtyEntryCount = 0;
  let untrackedEntryCount = 0;
  if (repoRoot) {
    try {
      const statusOutput = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], workspacePath)).stdout;
      for (const line of statusOutput.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith("??")) {
          untrackedEntryCount += 1;
          continue;
        }
        dirtyEntryCount += 1;
      }
    } catch (error) {
      warnings.push(
        `Could not read git working tree status for "${workspacePath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let aheadCount: number | null = null;
  let behindCount: number | null = null;
  let isMergedIntoBase: boolean | null = null;
  const baseRef = workspace.baseRef;

  if (repoRoot && baseRef) {
    try {
      const counts = (await runGit(["rev-list", "--left-right", "--count", `${baseRef}...HEAD`], workspacePath)).stdout.trim();
      const [behindRaw, aheadRaw] = counts.split(/\s+/);
      behindCount = behindRaw ? Number.parseInt(behindRaw, 10) : 0;
      aheadCount = aheadRaw ? Number.parseInt(aheadRaw, 10) : 0;
    } catch (error) {
      warnings.push(
        `Could not compare this workspace against ${baseRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await runGit(["merge-base", "--is-ancestor", "HEAD", baseRef], workspacePath);
      isMergedIntoBase = true;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : null;
      if (code === 1) isMergedIntoBase = false;
      else {
        warnings.push(
          `Could not determine whether this workspace is merged into ${baseRef}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    git: {
      repoRoot,
      workspacePath,
      branchName,
      baseRef,
      hasDirtyTrackedFiles: dirtyEntryCount > 0,
      hasUntrackedFiles: untrackedEntryCount > 0,
      dirtyEntryCount,
      untrackedEntryCount,
      aheadCount,
      behindCount,
      isMergedIntoBase,
      createdByRuntime,
    },
    warnings,
  };
}

export function readExecutionWorkspaceConfig(metadata: Record<string, unknown> | null | undefined): ExecutionWorkspaceConfig | null {
  const raw = isRecord(metadata?.config) ? metadata.config : null;
  if (!raw) return null;

  const config: ExecutionWorkspaceConfig = {
    environmentId: readNullableString(raw.environmentId),
    provisionCommand: readNullableString(raw.provisionCommand),
    teardownCommand: readNullableString(raw.teardownCommand),
    cleanupCommand: readNullableString(raw.cleanupCommand),
    workspaceRuntime: cloneRecord(raw.workspaceRuntime),
    desiredState: readDesiredState(raw.desiredState),
    serviceStates: readServiceStates(raw.serviceStates),
  };

  const hasConfig = Object.values(config).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });

  return hasConfig ? config : null;
}

export function mergeExecutionWorkspaceConfig(
  metadata: Record<string, unknown> | null | undefined,
  patch: Partial<ExecutionWorkspaceConfig> | null,
): Record<string, unknown> | null {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const current = readExecutionWorkspaceConfig(metadata) ?? {
    environmentId: null,
    provisionCommand: null,
    teardownCommand: null,
    cleanupCommand: null,
    workspaceRuntime: null,
    desiredState: null,
    serviceStates: null,
  };

  if (patch === null) {
    delete nextMetadata.config;
    return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
  }

  const nextConfig: ExecutionWorkspaceConfig = {
    environmentId: patch.environmentId !== undefined ? readNullableString(patch.environmentId) : current.environmentId,
    provisionCommand: patch.provisionCommand !== undefined ? readNullableString(patch.provisionCommand) : current.provisionCommand,
    teardownCommand: patch.teardownCommand !== undefined ? readNullableString(patch.teardownCommand) : current.teardownCommand,
    cleanupCommand: patch.cleanupCommand !== undefined ? readNullableString(patch.cleanupCommand) : current.cleanupCommand,
    workspaceRuntime: patch.workspaceRuntime !== undefined ? cloneRecord(patch.workspaceRuntime) : current.workspaceRuntime,
    desiredState:
      patch.desiredState !== undefined
        ? readDesiredState(patch.desiredState)
        : current.desiredState,
    serviceStates:
      patch.serviceStates !== undefined ? readServiceStates(patch.serviceStates) : current.serviceStates,
  };

  const hasConfig = Object.values(nextConfig).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });

  if (hasConfig) {
    nextMetadata.config = {
      environmentId: nextConfig.environmentId,
      provisionCommand: nextConfig.provisionCommand,
      teardownCommand: nextConfig.teardownCommand,
      cleanupCommand: nextConfig.cleanupCommand,
      workspaceRuntime: nextConfig.workspaceRuntime,
      desiredState: nextConfig.desiredState,
      serviceStates: nextConfig.serviceStates ?? null,
    };
  } else {
    delete nextMetadata.config;
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
}

function toRuntimeService(row: WorkspaceRuntimeServiceRow): WorkspaceRuntimeService {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    scopeType: row.scopeType as WorkspaceRuntimeService["scopeType"],
    scopeId: row.scopeId ?? null,
    serviceName: row.serviceName,
    status: row.status as WorkspaceRuntimeService["status"],
    lifecycle: row.lifecycle as WorkspaceRuntimeService["lifecycle"],
    reuseKey: row.reuseKey ?? null,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    port: row.port ?? null,
    url: row.url ?? null,
    provider: row.provider as WorkspaceRuntimeService["provider"],
    providerRef: row.providerRef ?? null,
    ownerAgentId: row.ownerAgentId ?? null,
    startedByRunId: row.startedByRunId ?? null,
    lastUsedAt: row.lastUsedAt,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt ?? null,
    stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
    healthStatus: row.healthStatus as WorkspaceRuntimeService["healthStatus"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExecutionWorkspace(
  row: ExecutionWorkspaceRow,
  runtimeServices: WorkspaceRuntimeService[] = [],
): ExecutionWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    sourceIssueId: row.sourceIssueId ?? null,
    mode: row.mode as ExecutionWorkspace["mode"],
    strategyType: row.strategyType as ExecutionWorkspace["strategyType"],
    name: row.name,
    status: row.status as ExecutionWorkspace["status"],
    cwd: row.cwd ?? null,
    repoUrl: row.repoUrl ?? null,
    baseRef: row.baseRef ?? null,
    branchName: row.branchName ?? null,
    providerType: row.providerType as ExecutionWorkspace["providerType"],
    providerRef: row.providerRef ?? null,
    derivedFromExecutionWorkspaceId: row.derivedFromExecutionWorkspaceId ?? null,
    lastUsedAt: row.lastUsedAt,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? null,
    cleanupEligibleAt: row.cleanupEligibleAt ?? null,
    cleanupReason: row.cleanupReason ?? null,
    config: readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    runtimeServices,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExecutionWorkspaceSummary(
  row: Pick<ExecutionWorkspaceRow, "id" | "name" | "mode" | "status" | "cwd" | "branchName" | "projectWorkspaceId" | "lastUsedAt">,
): ExecutionWorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode as ExecutionWorkspaceSummary["mode"],
    status: row.status as ExecutionWorkspaceSummary["status"],
    cwd: row.cwd ?? null,
    branchName: row.branchName ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    lastUsedAt: row.lastUsedAt,
  };
}

function usesInheritedProjectRuntimeServices(row: ExecutionWorkspaceRow) {
  if (row.mode !== "shared_workspace" || !row.projectWorkspaceId) return false;
  return !readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null)?.workspaceRuntime;
}

async function loadEffectiveRuntimeServicesByExecutionWorkspace(
  db: Db,
  companyId: string,
  rows: ExecutionWorkspaceRow[],
) {
  const executionRuntimeServices = await listCurrentRuntimeServicesForExecutionWorkspaces(
    db,
    companyId,
    rows.map((row) => row.id),
  );
  const projectWorkspaceIds = rows
    .filter((row) => usesInheritedProjectRuntimeServices(row))
    .map((row) => row.projectWorkspaceId)
    .filter((value): value is string => Boolean(value));
  const projectRuntimeServices = await listCurrentRuntimeServicesForProjectWorkspaces(
    db,
    companyId,
    [...new Set(projectWorkspaceIds)],
  );

  return new Map(
    rows.map((row) => [
      row.id,
      usesInheritedProjectRuntimeServices(row)
        ? (projectRuntimeServices.get(row.projectWorkspaceId!) ?? [])
        : (executionRuntimeServices.get(row.id) ?? []),
    ]),
  );
}

export function executionWorkspaceService(db: Db) {
  function buildListConditions(
    companyId: string,
    filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) {
    const conditions = [eq(executionWorkspaces.companyId, companyId)];
    if (filters?.projectId) conditions.push(eq(executionWorkspaces.projectId, filters.projectId));
    if (filters?.projectWorkspaceId) {
      conditions.push(eq(executionWorkspaces.projectWorkspaceId, filters.projectWorkspaceId));
    }
    if (filters?.issueId) conditions.push(eq(executionWorkspaces.sourceIssueId, filters.issueId));
    if (filters?.status) {
      const statuses = filters.status.split(",").map((value) => value.trim()).filter(Boolean);
      if (statuses.length === 1) conditions.push(eq(executionWorkspaces.status, statuses[0]!));
      else if (statuses.length > 1) conditions.push(inArray(executionWorkspaces.status, statuses));
    }
    if (filters?.reuseEligible) {
      conditions.push(inArray(executionWorkspaces.status, ["active", "idle", "in_review"]));
      conditions.push(isNull(executionWorkspaces.closedAt));
      conditions.push(inArray(executionWorkspaces.mode, ["isolated_workspace", "operator_branch", "adapter_managed", "cloud_sandbox"]));
    }
    return conditions;
  }

  return {
    list: async (companyId: string, filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    }) => {
      const conditions = buildListConditions(companyId, filters);
      const rows = await db
        .select()
        .from(executionWorkspaces)
        .where(and(...conditions))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt));
      const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, companyId, rows);
      return rows.map((row) =>
        toExecutionWorkspace(
          row,
          (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
        ),
      );
    },

    listSummaries: async (companyId: string, filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    }) => {
      const conditions = buildListConditions(companyId, filters);
      const rows = await db
        .select({
          id: executionWorkspaces.id,
          name: executionWorkspaces.name,
          mode: executionWorkspaces.mode,
          status: executionWorkspaces.status,
          cwd: executionWorkspaces.cwd,
          branchName: executionWorkspaces.branchName,
          projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
          lastUsedAt: executionWorkspaces.lastUsedAt,
        })
        .from(executionWorkspaces)
        .where(and(...conditions))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt));
      return rows.map((row) => toExecutionWorkspaceSummary(row));
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, row.companyId, [row]);
      return toExecutionWorkspace(
        row,
        (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
      );
    },

    getCloseReadiness: async (id: string): Promise<ExecutionWorkspaceCloseReadiness | null> => {
      const workspace = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      if (!workspace) return null;

      const runtimeServicesByWorkspaceId = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, workspace.companyId, [workspace]);
      const runtimeServices = (runtimeServicesByWorkspaceId.get(workspace.id) ?? []).map(toRuntimeService);

      const linkedIssues = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.companyId, workspace.companyId), eq(issues.executionWorkspaceId, workspace.id)));

      const projectWorkspace = workspace.projectWorkspaceId
        ? await db
            .select({
              id: projectWorkspaces.id,
              cwd: projectWorkspaces.cwd,
              cleanupCommand: projectWorkspaces.cleanupCommand,
              isPrimary: projectWorkspaces.isPrimary,
            })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, workspace.companyId),
                eq(projectWorkspaces.id, workspace.projectWorkspaceId),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;

      const primaryProjectWorkspace = workspace.projectId
        ? await db
            .select({
              id: projectWorkspaces.id,
            })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, workspace.companyId),
                eq(projectWorkspaces.projectId, workspace.projectId),
                eq(projectWorkspaces.isPrimary, true),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;

      const projectPolicy = workspace.projectId
        ? await db
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(and(eq(projects.id, workspace.projectId), eq(projects.companyId, workspace.companyId)))
            .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
        : null;

      const executionWorkspace = toExecutionWorkspace(workspace, runtimeServices);
      const config = readExecutionWorkspaceConfig((workspace.metadata as Record<string, unknown> | null) ?? null);
      const { git, warnings: gitWarnings } = await inspectGitCloseReadiness(executionWorkspace);
      const warnings = [...gitWarnings];
      const blockingReasons: string[] = [];
      const isSharedWorkspace = executionWorkspace.mode === "shared_workspace";
      const workspacePath = readNullableString(executionWorkspace.providerRef) ?? readNullableString(executionWorkspace.cwd);
      const resolvedWorkspacePath = workspacePath ? path.resolve(workspacePath) : null;
      const resolvedPrimaryWorkspacePath = projectWorkspace?.cwd ? path.resolve(projectWorkspace.cwd) : null;
      const isProjectPrimaryWorkspace =
        workspace.projectWorkspaceId != null
        && workspace.projectWorkspaceId === primaryProjectWorkspace?.id
        && resolvedWorkspacePath != null
        && resolvedPrimaryWorkspacePath != null
        && resolvedWorkspacePath === resolvedPrimaryWorkspacePath;

      const linkedIssueSummaries = linkedIssues.map((issue) => ({
        ...issue,
        isTerminal: TERMINAL_ISSUE_STATUSES.has(issue.status),
      }));

      const blockingIssues = linkedIssueSummaries.filter((issue) => !issue.isTerminal);
      if (blockingIssues.length > 0) {
        const linkedIssueMessage =
          blockingIssues.length === 1
            ? "This workspace is still linked to an open issue."
            : `This workspace is still linked to ${blockingIssues.length} open issues.`;
        if (isSharedWorkspace) {
          warnings.push(`${linkedIssueMessage} Archiving it will detach this shared workspace session from those issues, but keep the underlying project workspace available.`);
        } else {
          blockingReasons.push(linkedIssueMessage);
        }
      }

      if (isSharedWorkspace) {
        warnings.push("This shared workspace session points at project workspace infrastructure. Archiving it only removes the session record.");
      }

      if (runtimeServices.some((service) => service.status !== "stopped")) {
        warnings.push(
          runtimeServices.length === 1
            ? "Closing this workspace will stop 1 attached runtime service."
            : `Closing this workspace will stop ${runtimeServices.length} attached runtime services.`,
        );
      }

      if (git?.hasDirtyTrackedFiles) {
        warnings.push(
          git.dirtyEntryCount === 1
            ? "The workspace has 1 modified tracked file."
            : `The workspace has ${git.dirtyEntryCount} modified tracked files.`,
        );
      }
      if (git?.hasUntrackedFiles) {
        warnings.push(
          git.untrackedEntryCount === 1
            ? "The workspace has 1 untracked file."
            : `The workspace has ${git.untrackedEntryCount} untracked files.`,
        );
      }
      if (git?.aheadCount && git.aheadCount > 0 && git.isMergedIntoBase === false) {
        warnings.push(
          git.aheadCount === 1
            ? `This workspace is 1 commit ahead of ${git.baseRef ?? "the base ref"} and is not merged.`
            : `This workspace is ${git.aheadCount} commits ahead of ${git.baseRef ?? "the base ref"} and is not merged.`,
        );
      }
      if (git?.behindCount && git.behindCount > 0) {
        warnings.push(
          git.behindCount === 1
            ? `This workspace is 1 commit behind ${git.baseRef ?? "the base ref"}.`
            : `This workspace is ${git.behindCount} commits behind ${git.baseRef ?? "the base ref"}.`,
        );
      }

      const plannedActions: ExecutionWorkspaceCloseAction[] = [
        {
          kind: "archive_record",
          label: "Archive workspace record",
          description: "Keep the execution workspace history and issue linkage, but remove it from active workspace lists.",
          command: null,
        },
      ];

      if (runtimeServices.some((service) => service.status !== "stopped")) {
        plannedActions.push({
          kind: "stop_runtime_services",
          label: runtimeServices.length === 1 ? "Stop attached runtime service" : "Stop attached runtime services",
          description:
            runtimeServices.length === 1
              ? `${runtimeServices[0]?.serviceName ?? "A runtime service"} will be stopped before cleanup.`
              : `${runtimeServices.length} runtime services will be stopped before cleanup.`,
          command: null,
        });
      }

      const configuredCleanupCommands = [
        {
          kind: "cleanup_command" as const,
          label: "Run workspace cleanup command",
          description: "Workspace-specific cleanup runs before teardown.",
          command: config?.cleanupCommand ?? null,
        },
        {
          kind: "cleanup_command" as const,
          label: "Run project workspace cleanup command",
          description: "Project workspace cleanup runs before execution workspace teardown.",
          command: projectWorkspace?.cleanupCommand ?? null,
        },
      ];
      for (const action of configuredCleanupCommands) {
        if (!action.command) continue;
        plannedActions.push(action);
      }

      const teardownCommand = config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null;
      if (teardownCommand) {
        plannedActions.push({
          kind: "teardown_command",
          label: "Run teardown command",
          description: "Teardown runs after cleanup commands during workspace close.",
          command: teardownCommand,
        });
      }

      if (executionWorkspace.providerType === "git_worktree" && workspacePath) {
        plannedActions.push({
          kind: "git_worktree_remove",
          label: "Remove git worktree",
          description: `Workcell will run git worktree cleanup for ${workspacePath}.`,
          command: `git worktree remove --force ${workspacePath}`,
        });
      }

      if (git?.createdByRuntime && executionWorkspace.branchName) {
        plannedActions.push({
          kind: "git_branch_delete",
          label: "Delete runtime-created branch",
          description: "Workcell will try to delete the runtime-created branch after removing the worktree.",
          command: `git branch -d ${executionWorkspace.branchName}`,
        });
      }

      if (executionWorkspace.providerType === "local_fs" && git?.createdByRuntime && workspacePath) {
        const resolvedWorkspacePath = path.resolve(workspacePath);
        const resolvedProjectWorkspacePath = projectWorkspace?.cwd ? path.resolve(projectWorkspace.cwd) : null;
        const containsProjectWorkspace = resolvedProjectWorkspacePath
          ? (
              resolvedWorkspacePath === resolvedProjectWorkspacePath ||
              resolvedProjectWorkspacePath.startsWith(`${resolvedWorkspacePath}${path.sep}`)
            )
          : false;
        if (containsProjectWorkspace) {
          warnings.push(`Workcell will archive this workspace but keep "${workspacePath}" because it contains the project workspace.`);
        } else {
          plannedActions.push({
            kind: "remove_local_directory",
            label: "Remove runtime-created directory",
            description: `Workcell will remove the runtime-created directory at ${workspacePath}.`,
            command: `rm -rf ${workspacePath}`,
          });
        }
      }

      const state =
        blockingReasons.length > 0
          ? "blocked"
          : warnings.length > 0
            ? "ready_with_warnings"
            : "ready";

      return {
        workspaceId: workspace.id,
        state,
        blockingReasons,
        warnings,
        linkedIssues: linkedIssueSummaries,
        plannedActions,
        isDestructiveCloseAllowed: blockingReasons.length === 0,
        isSharedWorkspace,
        isProjectPrimaryWorkspace,
        git,
        runtimeServices,
      };
    },

    create: async (data: typeof executionWorkspaces.$inferInsert) => {
      const row = await db
        .insert(executionWorkspaces)
        .values(data)
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspace(row) : null;
    },

    update: async (id: string, patch: Partial<typeof executionWorkspaces.$inferInsert>) => {
      const row = await db
        .update(executionWorkspaces)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(executionWorkspaces.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspace(row) : null;
    },

    clearEnvironmentSelection: async (companyId: string, environmentId: string) => {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: executionWorkspaces.id,
            metadata: executionWorkspaces.metadata,
          })
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.companyId, companyId));

        let cleared = 0;
        const updatedAt = new Date();
        for (const row of rows) {
          const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
          const config = readExecutionWorkspaceConfig(metadata);
          if (config?.environmentId !== environmentId) continue;

          await tx
            .update(executionWorkspaces)
            .set({
              metadata: mergeExecutionWorkspaceConfig(metadata, { environmentId: null }),
              updatedAt,
            })
            .where(eq(executionWorkspaces.id, row.id));
          cleared += 1;
        }

        return cleared;
      });
    },
  };
}

export { toExecutionWorkspace };

// ---------------------------------------------------------------------------
// WC-219 (Item 1): periodic git-worktree prune + orphan-dir sweep (SAFETY-FIRST)
// ---------------------------------------------------------------------------
//
// Git worktrees created for runs/pairs (under <repoRoot>/.workcell/worktrees/)
// are torn down on explicit close, but a crash or an abandoned active pair can
// leak the worktree dir + its branch forever — nothing ever prunes them.
//
// This sweep has two parts, ordered by safety:
//   1. ALWAYS-SAFE: `git worktree prune` per repo. This is git's own GC — it only
//      removes the admin metadata for worktrees whose working dir is ALREADY gone.
//      It never deletes a live worktree, so it runs unconditionally.
//   2. ORPHAN-DIRECTORY (a dir under the worktrees base that is NOT registered
//      with git AND NOT referenced by any active execution_workspace row):
//      identified + LOGGED by default; deleted ONLY when BOTH (a) it is aged past
//      worktreeSweepMaxAgeMs AND (b) the opt-in WORKCELL_WORKTREE_SWEEP_DELETE=1
//      flag is set. With the flag off we log "would delete N" and stop.
//
// The decision logic is a pure DI function (planWorktreeSweep) so it is unit
// testable WITHOUT a real repo/fs. The impure shell (sweepLeakedWorktrees)
// gathers the inputs (git, fs, db) and applies the plan.

/** A directory found under a repo's worktrees base, with its last-modified time. */
export interface WorktreeDirCandidate {
  /** Absolute, resolved path to the candidate worktree directory. */
  path: string;
  /** Last-modified time (ms since epoch) used for the age threshold. */
  mtimeMs: number;
}

export interface WorktreeSweepPlanInput {
  /** Candidate dirs discovered on disk under every repo's worktrees base. */
  worktreeDirs: WorktreeDirCandidate[];
  /** Resolved paths git still has registered (`git worktree list`). */
  gitRegisteredPaths: Set<string>;
  /** Resolved worktree paths referenced by a non-terminal execution_workspace row. */
  activeReferencedPaths: Set<string>;
  /** Current time (ms since epoch). */
  now: number;
  /** A dir must be older than this (ms) before it is delete-eligible. */
  maxAgeMs: number;
  /** Opt-in: when false, delete-eligible orphans are logged, not deleted. */
  deleteEnabled: boolean;
}

export interface WorktreeSweepPlan {
  /** Orphans (not git-registered, not active-referenced), regardless of age. */
  orphanDirs: WorktreeDirCandidate[];
  /** Orphans that are aged past the threshold AND deletion is enabled — to remove. */
  toDelete: WorktreeDirCandidate[];
  /**
   * Orphans that will NOT be deleted this pass and why: either too young, or the
   * delete flag is off. These are logged so leaks are observable before any
   * destructive action is opted into.
   */
  toLog: Array<{ dir: WorktreeDirCandidate; reason: "too_young" | "delete_disabled" }>;
}

/**
 * Pure planner: decide which orphan worktree dirs to delete vs log. A dir is an
 * orphan iff it is neither registered with git NOR referenced by an active
 * execution workspace. Referenced or git-registered dirs never appear in the
 * plan — they are provably in use, so the sweep never touches them.
 */
export function planWorktreeSweep(input: WorktreeSweepPlanInput): WorktreeSweepPlan {
  const orphanDirs: WorktreeDirCandidate[] = [];
  const toDelete: WorktreeDirCandidate[] = [];
  const toLog: WorktreeSweepPlan["toLog"] = [];

  for (const dir of input.worktreeDirs) {
    const resolved = path.resolve(dir.path);
    if (input.gitRegisteredPaths.has(resolved) || input.activeReferencedPaths.has(resolved)) {
      // Provably in use — never a candidate for removal.
      continue;
    }
    orphanDirs.push(dir);

    const ageMs = input.now - dir.mtimeMs;
    const agedOut = ageMs >= input.maxAgeMs;
    if (!agedOut) {
      toLog.push({ dir, reason: "too_young" });
      continue;
    }
    if (!input.deleteEnabled) {
      toLog.push({ dir, reason: "delete_disabled" });
      continue;
    }
    toDelete.push(dir);
  }

  return { orphanDirs, toDelete, toLog };
}

/** Minimal logger surface (pino-compatible) the sweep needs. */
export interface WorktreeSweepLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Filesystem + git seam, injectable so the impure shell is testable. Defaults
 * (below) use real `git`/`fs`.
 */
export interface WorktreeSweepDeps {
  /** Run `git worktree prune` in a repo root; resolves even on failure (logged). */
  pruneRepo(repoRoot: string): Promise<void>;
  /** List worktree paths git has registered for a repo root. */
  listRegisteredWorktrees(repoRoot: string): Promise<string[]>;
  /** List immediate subdirectories of a worktrees base dir (absolute paths + mtime). */
  listWorktreeDirs(baseDir: string): Promise<WorktreeDirCandidate[]>;
  /** Recursively remove an orphan directory. */
  removeDir(dirPath: string): Promise<void>;
  now(): number;
}

const DEFAULT_WORKTREE_SUBDIR = path.join(".workcell", "worktrees");

function defaultWorktreeSweepDeps(): WorktreeSweepDeps {
  return {
    async pruneRepo(repoRoot) {
      // `git worktree prune` only drops admin metadata for already-missing
      // worktrees; it can never delete a live one. Failures are non-fatal.
      await execFileAsync("git", ["-C", repoRoot, "worktree", "prune"]).catch(() => {});
    },
    async listRegisteredWorktrees(repoRoot) {
      const { stdout } = await execFileAsync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]).catch(
        () => ({ stdout: "" }),
      );
      const paths: string[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) {
          paths.push(line.slice("worktree ".length).trim());
        }
      }
      return paths;
    },
    async listWorktreeDirs(baseDir) {
      let entries: Array<import("node:fs").Dirent>;
      try {
        entries = await fs.readdir(baseDir, { withFileTypes: true });
      } catch {
        return []; // base dir absent (no worktrees realized yet) — nothing to sweep.
      }
      const dirs: WorktreeDirCandidate[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.resolve(baseDir, entry.name);
        try {
          const stat = await fs.stat(full);
          dirs.push({ path: full, mtimeMs: stat.mtimeMs });
        } catch {
          // Disappeared between readdir and stat — skip.
        }
      }
      return dirs;
    },
    async removeDir(dirPath) {
      await fs.rm(dirPath, { recursive: true, force: true });
    },
    now: () => Date.now(),
  };
}

/**
 * Impure shell: enumerate every repo that owns git_worktree workspaces, run the
 * always-safe `git worktree prune`, then plan + (optionally) remove orphan dirs.
 *
 * Repo discovery: each git_worktree execution_workspace has a worktree path whose
 * worktrees base dir is `<repoRoot>/.workcell/worktrees`. We also fold in the
 * primary project-workspace checkouts so prune runs even for repos with no leaked
 * rows. The set of "active referenced paths" is the resolved worktree path of
 * every non-terminal git_worktree row — those are provably in use.
 */
export async function sweepLeakedWorktrees(
  db: Db,
  options: {
    maxAgeMs: number;
    deleteEnabled: boolean;
    logger: WorktreeSweepLogger;
    deps?: WorktreeSweepDeps;
  },
): Promise<{ pruned: number; orphans: number; deleted: number; loggedOrphans: number }> {
  const deps = options.deps ?? defaultWorktreeSweepDeps();

  // All git_worktree workspaces (any status) — closed/terminal rows tell us which
  // repos exist; non-terminal rows tell us which paths are still referenced.
  const worktreeRows = await db
    .select({
      cwd: executionWorkspaces.cwd,
      providerRef: executionWorkspaces.providerRef,
      status: executionWorkspaces.status,
      closedAt: executionWorkspaces.closedAt,
    })
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.providerType, "git_worktree"));

  const TERMINAL_WORKSPACE_STATUSES = new Set(["closed", "archived", "error"]);
  const worktreesBaseDirs = new Set<string>();
  const repoRoots = new Set<string>();
  const activeReferencedPaths = new Set<string>();

  // SAFETY: only ever treat a directory as a sweepable worktrees container when
  // it is literally `<repoRoot>/.workcell/worktrees`. This guarantees the orphan
  // sweep can never enumerate (and thus never delete) anything outside a
  // Workcell-owned worktrees dir, even if a providerRef is malformed or points
  // at a custom location. Returns the repo root when the convention matches.
  function conventionRepoRootForWorktree(worktreePath: string): string | null {
    const baseDir = path.dirname(worktreePath);
    if (path.basename(baseDir) !== "worktrees") return null;
    const dotWorkcell = path.dirname(baseDir);
    if (path.basename(dotWorkcell) !== ".workcell") return null;
    return path.dirname(dotWorkcell);
  }

  function registerWorktreePath(rawPath: string | null) {
    const trimmed = readNullableString(rawPath);
    if (!trimmed) return null;
    const resolved = path.resolve(trimmed);
    const repoRoot = conventionRepoRootForWorktree(resolved);
    if (repoRoot) {
      repoRoots.add(repoRoot);
      worktreesBaseDirs.add(path.join(repoRoot, DEFAULT_WORKTREE_SUBDIR));
    }
    return resolved;
  }

  for (const row of worktreeRows) {
    const resolved = registerWorktreePath(row.providerRef ?? row.cwd);
    const isTerminal = row.closedAt != null || TERMINAL_WORKSPACE_STATUSES.has(row.status);
    if (resolved && !isTerminal) {
      activeReferencedPaths.add(resolved);
    }
  }

  // Also include primary project-workspace checkouts so prune runs for repos that
  // currently have no leaked rows (these are the repo roots themselves).
  const primaryCheckouts = await db
    .select({ cwd: projectWorkspaces.cwd })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.isPrimary, true));
  for (const checkout of primaryCheckouts) {
    const cwd = readNullableString(checkout.cwd);
    if (!cwd) continue;
    const repoRoot = path.resolve(cwd);
    repoRoots.add(repoRoot);
    worktreesBaseDirs.add(path.join(repoRoot, DEFAULT_WORKTREE_SUBDIR));
  }

  // (1) Always-safe prune + collect git-registered paths.
  const gitRegisteredPaths = new Set<string>();
  let pruned = 0;
  for (const repoRoot of repoRoots) {
    await deps.pruneRepo(repoRoot);
    pruned += 1;
    for (const registered of await deps.listRegisteredWorktrees(repoRoot)) {
      const resolved = readNullableString(registered);
      if (resolved) gitRegisteredPaths.add(path.resolve(resolved));
    }
  }

  // (2) Enumerate on-disk worktree dirs and plan.
  const worktreeDirs: WorktreeDirCandidate[] = [];
  for (const baseDir of worktreesBaseDirs) {
    for (const dir of await deps.listWorktreeDirs(baseDir)) {
      worktreeDirs.push({ path: path.resolve(dir.path), mtimeMs: dir.mtimeMs });
    }
  }

  const plan = planWorktreeSweep({
    worktreeDirs,
    gitRegisteredPaths,
    activeReferencedPaths,
    now: deps.now(),
    maxAgeMs: options.maxAgeMs,
    deleteEnabled: options.deleteEnabled,
  });

  let deleted = 0;
  if (options.deleteEnabled && plan.toDelete.length > 0) {
    for (const dir of plan.toDelete) {
      try {
        await deps.removeDir(dir.path);
        deleted += 1;
        options.logger.warn(
          { worktreePath: dir.path, ageMs: deps.now() - dir.mtimeMs },
          "worktree sweep deleted an aged, unreferenced orphan worktree directory",
        );
      } catch (err) {
        options.logger.error(
          { worktreePath: dir.path, err },
          "worktree sweep failed to delete an orphan worktree directory",
        );
      }
    }
  }

  if (plan.toLog.length > 0) {
    const wouldDelete = plan.toLog.filter((entry) => entry.reason === "delete_disabled");
    if (wouldDelete.length > 0) {
      options.logger.warn(
        {
          count: wouldDelete.length,
          paths: wouldDelete.map((entry) => entry.dir.path),
          hint: "set WORKCELL_WORKTREE_SWEEP_DELETE=1 to remove these",
        },
        `worktree sweep would delete ${wouldDelete.length} orphan worktree dir(s) (deletion disabled)`,
      );
    }
    const tooYoung = plan.toLog.filter((entry) => entry.reason === "too_young");
    if (tooYoung.length > 0) {
      options.logger.info(
        { count: tooYoung.length, paths: tooYoung.map((entry) => entry.dir.path) },
        `worktree sweep found ${tooYoung.length} orphan worktree dir(s) not yet past the age threshold`,
      );
    }
  }

  return {
    pruned,
    orphans: plan.orphanDirs.length,
    deleted,
    loggedOrphans: plan.toLog.length,
  };
}
