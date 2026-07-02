import type {
  Agent,
  AgentDetail,
  AgentInstructionsBundle,
  AgentInstructionsFileDetail,
  AgentSkillSnapshot,
  AdapterEnvironmentTestResult,
  AgentKeyCreated,
  AgentRuntimeState,
  AgentTaskSession,
  AgentWakeupResponse,
  HeartbeatRun,
  Approval,
  AgentConfigRevision,
} from "@workcell/shared";
import type {
  AdapterModelProfileDefinition,
  AdapterModelProfileKey,
} from "@workcell/adapter-utils";
import { isUuidLike, normalizeAgentUrlKey } from "@workcell/shared";
import { ApiError, api } from "./client";

export interface AgentKey {
  id: string;
  name: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AdapterModel {
  id: string;
  label: string;
}

export type { AdapterModelProfileKey };
export type AdapterModelProfile = AdapterModelProfileDefinition;

export interface DetectedAdapterModel {
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
}

export interface ClaudeLoginResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  loginUrl: string | null;
  stdout: string;
  stderr: string;
}

export interface OrgNode {
  id: string;
  name: string;
  role: string;
  status: string;
  /**
   * Present when this node is a merged pair: the server collapses a mutually
   * exclusive active pair (owner ⇄ counterpart) into ONE node keyed by the
   * owner (primary) id, with the counterpart summarized here. Both members'
   * reports are merged under this node.
   */
  pair?: { id: string; name: string; role: string; status: string } | null;
  reports: OrgNode[];
}

export interface AgentHireResponse {
  agent: Agent;
  approval: Approval | null;
}

export interface AgentPermissionUpdate {
  canCreateAgents: boolean;
  canAssignTasks: boolean;
}

export interface AgentWakeRequest {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  forceFreshSession?: boolean;
}

// WC-209/WC-210 (deliberation timeline): client-side shapes for the persisted
// async dual-brain deliberation run + its turns. These mirror the DB rows the
// GET /agents/:id/deliberations[/:runId] routes return (drizzle camelCases the
// columns; timestamps serialize to ISO strings over the wire). Kept local to
// the UI api layer — the server rows are not exported from @workcell/shared.
export type DeliberationRunStatus = "running" | "completed" | "failed";

export interface DeliberationBrainSnapshot {
  adapter?: string | null;
  model?: string | null;
}

export interface DeliberationRun {
  id: string;
  companyId: string;
  agentId: string;
  task: string | null;
  status: DeliberationRunStatus;
  acceptedBy: string | null;
  rounds: number | null;
  finalOutput: string | null;
  totalCostCents: number | null;
  error: string | null;
  maxRounds: number | null;
  brainA: DeliberationBrainSnapshot | null;
  brainB: DeliberationBrainSnapshot | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DeliberationTurn {
  id: string;
  runId: string;
  round: number | null;
  brain: "A" | "B" | null;
  // Fusion: generate (a parallel candidate) | synthesize (the merged final).
  // propose/accept/revise are legacy values from pre-fusion runs.
  action: "generate" | "synthesize" | "propose" | "accept" | "revise" | null;
  content: string | null;
  feedback: string | null;
  costCents: number | null;
  createdAt: string;
}

export interface StartDeliberationResponse {
  runId: string;
  status: DeliberationRunStatus;
}

export interface DeliberationRunDetail {
  run: DeliberationRun;
  turns: DeliberationTurn[];
}

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

function agentPath(id: string, companyId?: string, suffix = "") {
  return withCompanyScope(`/agents/${encodeURIComponent(id)}${suffix}`, companyId);
}

export const agentsApi = {
  list: (companyId: string) => api.get<Agent[]>(`/companies/${companyId}/agents`),
  org: (companyId: string) => api.get<OrgNode[]>(`/companies/${companyId}/org`),
  listConfigurations: (companyId: string) =>
    api.get<Record<string, unknown>[]>(`/companies/${companyId}/agent-configurations`),
  get: async (id: string, companyId?: string) => {
    try {
      return await api.get<AgentDetail>(agentPath(id, companyId));
    } catch (error) {
      // Backward-compat fallback: if backend shortname lookup reports ambiguity,
      // resolve using company agent list while ignoring terminated agents.
      if (
        !(error instanceof ApiError) ||
        error.status !== 409 ||
        !companyId ||
        isUuidLike(id)
      ) {
        throw error;
      }

      const urlKey = normalizeAgentUrlKey(id);
      if (!urlKey) throw error;

      const agents = await api.get<Agent[]>(`/companies/${companyId}/agents`);
      const matches = agents.filter(
        (agent) => agent.status !== "terminated" && normalizeAgentUrlKey(agent.urlKey) === urlKey,
      );
      if (matches.length !== 1) throw error;
      return api.get<AgentDetail>(agentPath(matches[0]!.id, companyId));
    }
  },
  getConfiguration: (id: string, companyId?: string) =>
    api.get<Record<string, unknown>>(agentPath(id, companyId, "/configuration")),
  listConfigRevisions: (id: string, companyId?: string) =>
    api.get<AgentConfigRevision[]>(agentPath(id, companyId, "/config-revisions")),
  getConfigRevision: (id: string, revisionId: string, companyId?: string) =>
    api.get<AgentConfigRevision>(agentPath(id, companyId, `/config-revisions/${revisionId}`)),
  rollbackConfigRevision: (id: string, revisionId: string, companyId?: string) =>
    api.post<Agent>(agentPath(id, companyId, `/config-revisions/${revisionId}/rollback`), {}),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Agent>(`/companies/${companyId}/agents`, data),
  hire: (companyId: string, data: Record<string, unknown>) =>
    api.post<AgentHireResponse>(`/companies/${companyId}/agent-hires`, data),
  update: (id: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<Agent>(agentPath(id, companyId), data),
  updatePermissions: (id: string, data: AgentPermissionUpdate, companyId?: string) =>
    api.patch<AgentDetail>(agentPath(id, companyId, "/permissions"), data),
  instructionsBundle: (id: string, companyId?: string) =>
    api.get<AgentInstructionsBundle>(agentPath(id, companyId, "/instructions-bundle")),
  updateInstructionsBundle: (
    id: string,
    data: {
      mode?: "managed" | "external";
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    },
    companyId?: string,
  ) => api.patch<AgentInstructionsBundle>(agentPath(id, companyId, "/instructions-bundle"), data),
  instructionsFile: (id: string, relativePath: string, companyId?: string) =>
    api.get<AgentInstructionsFileDetail>(
      agentPath(id, companyId, `/instructions-bundle/file?path=${encodeURIComponent(relativePath)}`),
    ),
  saveInstructionsFile: (
    id: string,
    data: { path: string; content: string; clearLegacyPromptTemplate?: boolean },
    companyId?: string,
  ) => api.put<AgentInstructionsFileDetail>(agentPath(id, companyId, "/instructions-bundle/file"), data),
  deleteInstructionsFile: (id: string, relativePath: string, companyId?: string) =>
    api.delete<AgentInstructionsBundle>(
      agentPath(id, companyId, `/instructions-bundle/file?path=${encodeURIComponent(relativePath)}`),
    ),
  pause: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/pause"), {}),
  resume: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/resume"), {}),
  approve: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/approve"), {}),
  terminate: (id: string, companyId?: string) => api.post<Agent>(agentPath(id, companyId, "/terminate"), {}),
  remove: (id: string, companyId?: string) => api.delete<{ ok: true }>(agentPath(id, companyId)),
  listKeys: (id: string, companyId?: string) => api.get<AgentKey[]>(agentPath(id, companyId, "/keys")),
  skills: (id: string, companyId?: string) =>
    api.get<AgentSkillSnapshot>(agentPath(id, companyId, "/skills")),
  syncSkills: (id: string, desiredSkills: string[], companyId?: string) =>
    api.post<AgentSkillSnapshot>(agentPath(id, companyId, "/skills/sync"), { desiredSkills }),
  createKey: (id: string, name: string, companyId?: string) =>
    api.post<AgentKeyCreated>(agentPath(id, companyId, "/keys"), { name }),
  revokeKey: (agentId: string, keyId: string, companyId?: string) =>
    api.delete<{ ok: true }>(agentPath(agentId, companyId, `/keys/${encodeURIComponent(keyId)}`)),
  runtimeState: (id: string, companyId?: string) =>
    api.get<AgentRuntimeState>(agentPath(id, companyId, "/runtime-state")),
  taskSessions: (id: string, companyId?: string) =>
    api.get<AgentTaskSession[]>(agentPath(id, companyId, "/task-sessions")),
  resetSession: (id: string, taskKey?: string | null, companyId?: string) =>
    api.post<void>(agentPath(id, companyId, "/runtime-state/reset-session"), { taskKey: taskKey ?? null }),
  adapterModels: (
    companyId: string,
    type: string,
    options?: { refresh?: boolean; environmentId?: string | null },
  ) => {
    const params = new URLSearchParams();
    if (options?.refresh) params.set("refresh", "1");
    if (options?.environmentId) params.set("environmentId", options.environmentId);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return api.get<AdapterModel[]>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/models${query}`,
    );
  },
  detectModel: (companyId: string, type: string) =>
    api.get<DetectedAdapterModel | null>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/detect-model`,
    ),
  adapterModelProfiles: (companyId: string, type: string) =>
    api.get<AdapterModelProfile[]>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/model-profiles`,
    ),
  testEnvironment: (
    companyId: string,
    type: string,
    data: {
      adapterConfig: Record<string, unknown>;
      environmentId?: string | null;
    },
  ) =>
    api.post<AdapterEnvironmentTestResult>(
      `/companies/${companyId}/adapters/${type}/test-environment`,
      data,
    ),
  invoke: (id: string, companyId?: string, data: AgentWakeRequest = {}) =>
    api.post<HeartbeatRun>(agentPath(id, companyId, "/heartbeat/invoke"), data),
  wakeup: (
    id: string,
    data: AgentWakeRequest,
    companyId?: string,
  ) => api.post<AgentWakeupResponse>(agentPath(id, companyId, "/wakeup"), data),
  loginWithClaude: (id: string, companyId?: string) =>
    api.post<ClaudeLoginResult>(agentPath(id, companyId, "/claude-login"), {}),
  // WC-210 (deliberation timeline): start a LIVE async dual-brain deliberation
  // run → 202 { runId, status:"running" }. The backend is flag-gated
  // (WORKCELL_PAIR_LIVE_LLM) and returns 503 { code:"deliberation_live_disabled" }
  // when live LLM is off — the caller surfaces that as a "live disabled" message
  // rather than a hard error.
  startDeliberation: (
    id: string,
    data: { task: string; maxRoundsOverride?: number },
    companyId?: string,
  ) => api.post<StartDeliberationResponse>(agentPath(id, companyId, "/deliberate"), data),
  // List recent deliberation runs for the agent (newest-first).
  listDeliberations: (id: string, companyId?: string) =>
    api.get<{ runs: DeliberationRun[] }>(agentPath(id, companyId, "/deliberations")),
  // Fetch one run + its ordered turns (poll target while status==="running").
  getDeliberation: (id: string, runId: string, companyId?: string) =>
    api.get<DeliberationRunDetail>(
      agentPath(id, companyId, `/deliberations/${encodeURIComponent(runId)}`),
    ),
  availableSkills: () =>
    api.get<{ skills: AvailableSkill[] }>("/skills/available"),
};

export interface AvailableSkill {
  name: string;
  description: string;
  isWorkcellManaged: boolean;
}
