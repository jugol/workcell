import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@workcell/adapter-utils";
// WC-69: inject agent-declared MCP servers into CODEX_HOME/config.toml (flag-gated).
import { buildCodexMcpToml, codexMcpServerTableKey, isAdapterMcpInjectionEnabled, type McpServerSpec } from "@workcell/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesWorkcellBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetWorkcellBridge,
} from "@workcell/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  parseObject,
  buildWorkcellEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureWorkcellSkillSymlink,
  ensurePathInEnv,
  refreshWorkcellWorkspaceEnvForExecution,
  readWorkcellRuntimeSkillEntries,
  readWorkcellIssueWorkModeFromContext,
  resolveWorkcellDesiredSkillNames,
  renderTemplate,
  renderWorkcellWakePrompt,
  stringifyWorkcellWakePayload,
  DEFAULT_WORKCELL_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
} from "@workcell/adapter-utils/server-utils";
import {
  parseCodexJsonl,
  extractCodexRetryNotBefore,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
} from "./parse.js";
import { pathExists, prepareManagedCodexHome, resolveManagedCodexHomeDir, resolveSharedCodexHomeDir } from "./codex-home.js";
import { resolveCodexDesiredSkillNames } from "./skills.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;

function stripCodexRolloutNoise(text: string): string {
  const parts = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      kept.push(part);
      continue;
    }
    if (CODEX_ROLLOUT_NOISE_RE.test(trimmed)) continue;
    kept.push(part);
  }
  return kept.join("\n");
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveCodexBillingType(env: Record<string, string>): "api" | "subscription" {
  // Codex uses API-key auth when OPENAI_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ? "api" : "subscription";
}

function resolveCodexBiller(env: Record<string, string>, billingType: "api" | "subscription"): string {
  const openAiCompatibleBiller = inferOpenAiCompatibleBiller(env, "openai");
  if (openAiCompatibleBiller === "openrouter") return "openrouter";
  return billingType === "subscription" ? "chatgpt" : openAiCompatibleBiller ?? "openai";
}

async function isLikelyWorkcellRepoRoot(candidate: string): Promise<boolean> {
  const [hasWorkspace, hasPackageJson, hasServerDir, hasAdapterUtilsDir] = await Promise.all([
    pathExists(path.join(candidate, "pnpm-workspace.yaml")),
    pathExists(path.join(candidate, "package.json")),
    pathExists(path.join(candidate, "server")),
    pathExists(path.join(candidate, "packages", "adapter-utils")),
  ]);

  return hasWorkspace && hasPackageJson && hasServerDir && hasAdapterUtilsDir;
}

async function isLikelyWorkcellRuntimeSkillPath(
  candidate: string,
  skillName: string,
  options: { requireSkillMarkdown?: boolean } = {},
): Promise<boolean> {
  if (path.basename(candidate) !== skillName) return false;
  const skillsRoot = path.dirname(candidate);
  if (path.basename(skillsRoot) !== "skills") return false;
  if (options.requireSkillMarkdown !== false && !(await pathExists(path.join(candidate, "SKILL.md")))) {
    return false;
  }

  let cursor = path.dirname(skillsRoot);
  for (let depth = 0; depth < 6; depth += 1) {
    if (await isLikelyWorkcellRepoRoot(cursor)) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return false;
}

async function pruneBrokenUnavailableWorkcellSkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
  onLog: AdapterExecutionContext["onLog"],
) {
  const allowed = new Set(Array.from(allowedSkillNames));
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (allowed.has(entry.name) || !entry.isSymbolicLink()) continue;

    const target = path.join(skillsHome, entry.name);
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) continue;

    const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
    if (await pathExists(resolvedLinkedPath)) continue;
    if (
      !(await isLikelyWorkcellRuntimeSkillPath(resolvedLinkedPath, entry.name, {
        requireSkillMarkdown: false,
      }))
    ) {
      continue;
    }

    await fs.unlink(target).catch(() => {});
    await onLog(
      "stdout",
      `[workcell] Removed stale Codex skill "${entry.name}" from ${skillsHome}\n`,
    );
  }
}

function resolveCodexSkillsDir(codexHome: string): string {
  return path.join(codexHome, "skills");
}

type EnsureCodexSkillsInjectedOptions = {
  skillsHome?: string;
  skillsEntries?: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames?: string[];
  linkSkill?: (source: string, target: string) => Promise<void>;
};

type CodexTransientFallbackMode =
  | "same_session"
  | "safer_invocation"
  | "fresh_session"
  | "fresh_session_safer_invocation";

function readCodexTransientFallbackMode(context: Record<string, unknown>): CodexTransientFallbackMode | null {
  const value = asString(context.codexTransientFallbackMode, "").trim();
  switch (value) {
    case "same_session":
    case "safer_invocation":
    case "fresh_session":
    case "fresh_session_safer_invocation":
      return value;
    default:
      return null;
  }
}

function fallbackModeUsesSaferInvocation(mode: CodexTransientFallbackMode | null): boolean {
  return mode === "safer_invocation" || mode === "fresh_session_safer_invocation";
}

function fallbackModeUsesFreshSession(mode: CodexTransientFallbackMode | null): boolean {
  return mode === "fresh_session" || mode === "fresh_session_safer_invocation";
}

function buildCodexTransientHandoffNote(input: {
  previousSessionId: string | null;
  fallbackMode: CodexTransientFallbackMode;
  continuationSummaryBody: string | null;
}): string {
  return [
    "Workcell session handoff:",
    input.previousSessionId ? `- Previous session: ${input.previousSessionId}` : "",
    "- Rotation reason: repeated Codex transient remote-compaction failures",
    `- Fallback mode: ${input.fallbackMode}`,
    input.continuationSummaryBody
      ? `- Issue continuation summary: ${input.continuationSummaryBody.slice(0, 1_500)}`
      : "",
    "Continue from the current task state. Rebuild only the minimum context you need.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function ensureCodexSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureCodexSkillsInjectedOptions = {},
) {
  const allSkillsEntries = options.skillsEntries ?? await readWorkcellRuntimeSkillEntries({}, __moduleDir);
  const desiredSkillNames =
    options.desiredSkillNames ?? allSkillsEntries.map((entry) => entry.key);
  const desiredSet = new Set(desiredSkillNames);
  const skillsEntries = allSkillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (skillsEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? resolveCodexSkillsDir(resolveSharedCodexHomeDir());
  await fs.mkdir(skillsHome, { recursive: true });
  const linkSkill = options.linkSkill;
  for (const entry of skillsEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const existing = await fs.lstat(target).catch(() => null);
      if (existing?.isSymbolicLink()) {
        const linkedPath = await fs.readlink(target).catch(() => null);
        const resolvedLinkedPath = linkedPath
          ? path.resolve(path.dirname(target), linkedPath)
          : null;
        if (
          resolvedLinkedPath &&
          resolvedLinkedPath !== entry.source &&
          (await isLikelyWorkcellRuntimeSkillPath(resolvedLinkedPath, entry.runtimeName))
        ) {
          await fs.unlink(target);
          if (linkSkill) {
            await linkSkill(entry.source, target);
          } else {
            await fs.symlink(entry.source, target);
          }
          await onLog(
            "stdout",
            `[workcell] Repaired Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
          );
          continue;
        }
      }

      const result = await ensureWorkcellSkillSymlink(entry.source, target, linkSkill);
      if (result === "skipped") continue;

      await onLog(
        "stdout",
        `[workcell] ${result === "repaired" ? "Repaired" : "Injected"} Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[workcell] Failed to inject Codex skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  await pruneBrokenUnavailableWorkcellSkillSymlinks(
    skillsHome,
    skillsEntries.map((entry) => entry.runtimeName),
    onLog,
  );
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_WORKCELL_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "codex");
  const model = asString(config.model, "");

  const workspaceContext = parseObject(context.workcellWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.workcellWorkspaces)
    ? context.workcellWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.workcellRuntimeServiceIntents)
    ? context.workcellRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.workcellRuntimeServices)
    ? context.workcellRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.workcellRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const envConfig = parseObject(config.env);
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const codexSkillEntries = await readWorkcellRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveCodexDesiredSkillNames(config, codexSkillEntries);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const configuredOpenAiApiKey =
    typeof envConfig.OPENAI_API_KEY === "string" && envConfig.OPENAI_API_KEY.trim().length > 0
      ? envConfig.OPENAI_API_KEY.trim()
      : null;
  const preparedManagedCodexHome =
    configuredCodexHome
      ? null
      : await prepareManagedCodexHome(process.env, onLog, agent.companyId, {
          apiKey: configuredOpenAiApiKey,
        });
  const defaultCodexHome = resolveManagedCodexHomeDir(process.env, agent.companyId);
  const effectiveCodexHome = configuredCodexHome ?? preparedManagedCodexHome ?? defaultCodexHome;
  await fs.mkdir(effectiveCodexHome, { recursive: true });

  // WC-69: when MCP injection is enabled (WORKCELL_ADAPTER_MCP_INJECTION, OFF by
  // default) and we're running locally, append the agent's declared MCP servers
  // (heartbeat put them on context.workcellMcpServers) to CODEX_HOME/config.toml
  // as [mcp_servers.*] tables (Codex's MCP config format) — mirrors the
  // claude-local .mcp.json path (WC-67). Default runs append nothing, so the
  // invocation is unchanged. Servers already present in config.toml are skipped
  // to avoid duplicate-table TOML errors. Remote relay is a documented follow-up.
  if (!executionTargetIsRemote && isAdapterMcpInjectionEnabled(process.env)) {
    const declared = Array.isArray(context.workcellMcpServers)
      ? (context.workcellMcpServers as McpServerSpec[])
      : [];
    if (declared.length > 0) {
      try {
        const configTomlPath = path.join(effectiveCodexHome, "config.toml");
        const existing = await fs.readFile(configTomlPath, "utf-8").catch(() => "");
        // WC-115: de-dupe against the SAME escaped table key the writer emits
        // (a name with a quote/control char would otherwise be written escaped
        // but matched raw, re-injecting a duplicate table). Keep the bare-key
        // form as a secondary heuristic for externally hand-written configs.
        const fresh = declared.filter(
          (s) => !existing.includes(codexMcpServerTableKey(s.name)) && !existing.includes(`mcp_servers.${s.name}`),
        );
        if (fresh.length > 0) {
          const fragment = `\n# WC-67/69: Workcell-injected MCP servers\n${buildCodexMcpToml(fresh)}`;
          await fs.appendFile(configTomlPath, fragment, "utf-8");
        }
      } catch (err) {
        await onLog(
          "stderr",
          `[workcell] Failed to write Codex MCP config (config.toml); continuing without it: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }
  // Inject skills into the same CODEX_HOME that Codex will actually run with
  // (managed home in the default case, or an explicit override from adapter config).
  const codexSkillsDir = resolveCodexSkillsDir(effectiveCodexHome);
  await ensureCodexSkillsInjected(
    onLog,
    {
      skillsHome: codexSkillsDir,
      skillsEntries: codexSkillEntries,
      desiredSkillNames,
    },
  );
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  const preparedExecutionTargetRuntime = executionTargetIsRemote
    ? await (async () => {
        await onLog(
          "stdout",
          `[workcell] Syncing workspace and CODEX_HOME to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        return await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "codex",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          assets: [
            {
              key: "home",
              localDir: effectiveCodexHome,
              followSymlinks: true,
            },
          ],
        });
      })()
    : null;
  if (preparedExecutionTargetRuntime?.workspaceRemoteDir) {
    effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir;
  }
  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
  const executionTargetIsSandbox =
    runtimeExecutionTarget?.kind === "remote" && runtimeExecutionTarget.transport === "sandbox";
  const restoreRemoteWorkspace = preparedExecutionTargetRuntime
    ? () => preparedExecutionTargetRuntime.restoreWorkspace()
    : null;
  let workcellBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetWorkcellBridge>> = null;
  const remoteCodexHome = executionTargetIsRemote
    ? preparedExecutionTargetRuntime?.assetDirs.home ??
      path.posix.join(effectiveExecutionCwd, ".workcell-runtime", "codex", "home")
    : null;
  const hasExplicitApiKey =
    typeof envConfig.WORKCELL_API_KEY === "string" && envConfig.WORKCELL_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildWorkcellEnv(agent) };
  env.WORKCELL_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyWorkcellWakePayload(context.workcellWake);
  const issueWorkMode = readWorkcellIssueWorkModeFromContext(context);
  if (wakeTaskId) {
    env.WORKCELL_TASK_ID = wakeTaskId;
  }
  if (issueWorkMode) {
    env.WORKCELL_ISSUE_WORK_MODE = issueWorkMode;
  }
  if (wakeReason) {
    env.WORKCELL_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.WORKCELL_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.WORKCELL_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.WORKCELL_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.WORKCELL_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (wakePayloadJson) {
    env.WORKCELL_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }
  refreshWorkcellWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  if (runtimeServiceIntents.length > 0) {
    env.WORKCELL_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.WORKCELL_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.WORKCELL_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }
  env.CODEX_HOME = remoteCodexHome ?? effectiveCodexHome;
  if (!hasExplicitApiKey && authToken) {
    env.WORKCELL_API_KEY = authToken;
  }
  if (executionTargetIsRemote && adapterExecutionTargetUsesWorkcellBridge(runtimeExecutionTarget)) {
    workcellBridge = await startAdapterExecutionTargetWorkcellBridge({
      runId,
      target: runtimeExecutionTarget,
      runtimeRootDir: preparedExecutionTargetRuntime?.runtimeRootDir,
      adapterKey: "codex",
      timeoutSec,
      hostApiToken: env.WORKCELL_API_KEY,
      onLog,
    });
    if (workcellBridge) {
      Object.assign(env, workcellBridge.env);
    }
  }
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveCodexBillingType(effectiveEnv);
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(effectiveEnv)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv);
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const codexTransientFallbackMode = readCodexTransientFallbackMode(context);
  const forceSaferInvocation = fallbackModeUsesSaferInvocation(codexTransientFallbackMode);
  const forceFreshSession = fallbackModeUsesFreshSession(codexTransientFallbackMode);
  const sessionId = canResumeSession && !forceFreshSession ? runtimeSessionId : null;
  if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[workcell] Codex session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[workcell] Codex session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  let instructionsChars = 0;
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      instructionsChars = instructionsPrefix.length;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[workcell] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const repoAgentsNote =
    "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Workcell does not currently suppress that discovery.";
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderWorkcellWakePrompt(context.workcellWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  instructionsChars = promptInstructionsPrefix.length;
  const continuationSummary = parseObject(context.workcellContinuationSummary);
  const continuationSummaryBody = asString(continuationSummary.body, "").trim() || null;
  const codexFallbackHandoffNote =
    forceFreshSession
      ? buildCodexTransientHandoffNote({
          previousSessionId: runtimeSessionId || runtime.sessionId || null,
          fallbackMode: codexTransientFallbackMode ?? "fresh_session",
          continuationSummaryBody,
        })
      : "";
  const commandNotes = (() => {
    if (!instructionsFilePath) {
      const notes = [repoAgentsNote];
      if (forceSaferInvocation) {
        notes.push("Codex transient fallback requested safer invocation settings for this retry.");
      }
      if (forceFreshSession) {
        notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
      }
      return notes;
    }
    if (instructionsPrefix.length > 0) {
      if (shouldUseResumeDeltaPrompt) {
        const notes = [
          `Loaded agent instructions from ${instructionsFilePath}`,
          "Skipped stdin instruction reinjection because an existing Codex session is being resumed with a wake delta.",
          repoAgentsNote,
        ];
        if (forceSaferInvocation) {
          notes.push("Codex transient fallback requested safer invocation settings for this retry.");
        }
        if (forceFreshSession) {
          notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
        }
        return notes;
      }
      const notes = [
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        repoAgentsNote,
      ];
      if (forceSaferInvocation) {
        notes.push("Codex transient fallback requested safer invocation settings for this retry.");
      }
      if (forceFreshSession) {
        notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
      }
      return notes;
    }
    const notes = [
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      repoAgentsNote,
    ];
    if (forceSaferInvocation) {
      notes.push("Codex transient fallback requested safer invocation settings for this retry.");
    }
    if (forceFreshSession) {
      notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
    }
    return notes;
  })();
  if (executionTargetIsSandbox) {
    commandNotes.push(
      "Added --skip-git-repo-check for sandbox execution because Codex requires an explicit trust bypass in headless remote workspaces.",
    );
  }
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.workcellSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    codexFallbackHandoffNote,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const execArgs = buildCodexExecArgs(
      forceSaferInvocation ? { ...config, fastMode: false } : config,
      {
        resumeSessionId,
        skipGitRepoCheck: executionTargetIsSandbox,
      },
    );
    const args = execArgs.args;
    const commandNotesWithFastMode =
      execArgs.fastModeIgnoredReason == null
        ? commandNotes
        : [...commandNotes, execArgs.fastModeIgnoredReason];
    if (onMeta) {
      await onMeta({
        adapterType: "codex_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandNotes: commandNotesWithFastMode,
        commandArgs: args.map((value, idx) => {
          if (idx === args.length - 1 && value !== "-") return `<prompt ${prompt.length} chars>`;
          return value;
        }),
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: async (stream, chunk) => {
        if (stream !== "stderr") {
          await onLog(stream, chunk);
          return;
        }
        const cleaned = stripCodexRolloutNoise(chunk);
        if (!cleaned.trim()) return;
        await onLog(stream, cleaned);
      },
    });
    const cleanedStderr = stripCodexRolloutNoise(proc.stderr);
    return {
      proc: {
        ...proc,
        stderr: cleanedStderr,
      },
      rawStderr: proc.stderr,
      parsed: parseCodexJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: { proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string }; rawStderr: string; parsed: ReturnType<typeof parseCodexJsonl> },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const canFallbackToRuntimeSession = !isRetry && !forceFreshSession;
    const resolvedSessionId =
      attempt.parsed.sessionId ??
      (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd: effectiveExecutionCwd,
        ...(executionTargetIsRemote
          ? {
              remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
            }
          : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `Codex exited with code ${attempt.proc.exitCode ?? -1}`;
    const transientRetryNotBefore =
      (attempt.proc.exitCode ?? 0) !== 0
        ? extractCodexRetryNotBefore({
            stdout: attempt.proc.stdout,
            stderr: attempt.proc.stderr,
            errorMessage: fallbackErrorMessage,
          })
        : null;
    const transientUpstream =
      (attempt.proc.exitCode ?? 0) !== 0 &&
      isCodexTransientUpstreamError({
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        errorMessage: fallbackErrorMessage,
      });

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        (attempt.proc.exitCode ?? 0) === 0
          ? null
          : fallbackErrorMessage,
      errorCode:
        transientUpstream
          ? "codex_transient_upstream"
          : null,
      errorFamily: transientUpstream ? "transient_upstream" : null,
      retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "openai",
      biller: resolveCodexBiller(effectiveEnv, billingType),
      model,
      billingType,
      costUsd: null,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        ...(transientUpstream ? { errorFamily: "transient_upstream" } : {}),
        ...(transientRetryNotBefore ? { retryNotBefore: transientRetryNotBefore.toISOString() } : {}),
        ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean((clearSessionOnMissingSession || forceFreshSession) && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isCodexUnknownSessionError(initial.proc.stdout, initial.rawStderr)
    ) {
      await onLog(
        "stdout",
        `[workcell] Codex resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }

    return toResult(initial, false, false);
  } finally {
    if (workcellBridge) {
      await workcellBridge.stop();
    }
    if (restoreRemoteWorkspace) {
      await onLog(
        "stdout",
        `[workcell] Restoring workspace changes from ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      await restoreRemoteWorkspace();
    }
  }
}
