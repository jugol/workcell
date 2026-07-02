import type {
  AgentAdapterType,
  ModelProfileKey,
  PauseReason,
  AgentRole,
  AgentStatus,
} from "../constants.js";
import type {
  CompanyMembership,
  PrincipalPermissionGrant,
} from "./access.js";

export interface AgentPermissions {
  canCreateAgents: boolean;
}

export interface AgentModelProfileConfig {
  enabled?: boolean;
  label?: string;
  adapterConfig: Record<string, unknown>;
}

export interface AgentRuntimeConfig extends Record<string, unknown> {
  modelProfiles?: Partial<Record<ModelProfileKey, AgentModelProfileConfig>>;
}

// WC-204 (deliberation mode, slice 1): per-agent dual-brain internal consensus
// config. Mirrors agentDeliberationConfigSchema (validators/agent-deliberation).
// When enabled the agent runs an internal brain-A propose → brain-B review loop
// (see server agent-deliberation engine). null/absent → deliberation off.
//
// WC-208 (per-brain adapter): each brain independently chooses BOTH its adapter
// and its model. `adapter` null/absent → inherit the agent's own adapterType;
// `model` null/absent → inherit the agent's configured model. This lets a user
// run cross-adapter brains (brain A = claude_local, brain B = codex_local) OR
// two models within one adapter.
export interface AgentDeliberationBrainConfig {
  adapter?: string | null;
  model?: string | null;
}

// WC-PANEL: an independent review panel — each member is a reviewer
// (adapter + model). Used only when reviewMode === "panel".
export interface AgentDeliberationPanelConfig {
  members: AgentDeliberationBrainConfig[];
  // How many members must ACCEPT for the panel to accept. Absent = majority.
  minAgree?: number;
}

export interface AgentDeliberationConfig {
  enabled: boolean;
  brainA: AgentDeliberationBrainConfig;
  brainB: AgentDeliberationBrainConfig;
  maxRounds: number;
  // WC-REVMODE/WC-PANEL/WC-TRACK (optional review-mode upgrades; absent ⇒
  // single brainB review, auto track — i.e. the original behavior). Mirrors
  // agentDeliberationConfigSchema in validators/agent-deliberation.ts.
  reviewMode?: "single" | "panel";
  panel?: AgentDeliberationPanelConfig | null;
  track?: "auto" | "a" | "b";
}

export type AgentInstructionsBundleMode = "managed" | "external";

export interface AgentInstructionsFileSummary {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
}

export interface AgentInstructionsFileDetail extends AgentInstructionsFileSummary {
  content: string;
}

export interface AgentInstructionsBundle {
  agentId: string;
  companyId: string;
  mode: AgentInstructionsBundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
}

export interface AgentAccessState {
  canAssignTasks: boolean;
  taskAssignSource: "simple_default" | "explicit_grant" | "agent_creator" | "orchestrator_role" | "none";
  membership: CompanyMembership | null;
  grants: PrincipalPermissionGrant[];
}

export interface AgentChainOfCommandEntry {
  id: string;
  name: string;
  role: AgentRole;
  title: string | null;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  capabilities: string | null;
  adapterType: AgentAdapterType;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: AgentRuntimeConfig;
  defaultEnvironmentId?: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  permissions: AgentPermissions;
  deliberation?: AgentDeliberationConfig | null;
  lastHeartbeatAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDetail extends Agent {
  chainOfCommand: AgentChainOfCommandEntry[];
  access: AgentAccessState;
}

export interface AgentKeyCreated {
  id: string;
  name: string;
  token: string;
  createdAt: Date;
}

export interface AgentConfigRevision {
  id: string;
  companyId: string;
  agentId: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  source: string;
  rolledBackFromRevisionId: string | null;
  changedKeys: string[];
  beforeConfig: Record<string, unknown>;
  afterConfig: Record<string, unknown>;
  createdAt: Date;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";
export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}
