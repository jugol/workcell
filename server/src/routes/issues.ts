import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@workcell/db";
import {
  activityLog,
  agents,
  executionWorkspaces,
  heartbeatRuns,
  issueExecutionDecisions,
  issueRelations,
  issues as issueRows,
  projectWorkspaces,
} from "@workcell/db";
import {
  addIssueCommentSchema,
  acceptIssueThreadInteractionSchema,
  cancelIssueThreadInteractionSchema,
  companySearchQuerySchema,
  createIssueAttachmentMetadataSchema,
  createIssueThreadInteractionSchema,
  createIssueWorkProductSchema,
  createDesignArtifactSchema,
  slugifyScreenKey,
  extractDesignSystemSchema,
  createIssueLabelSchema,
  checkoutIssueSchema,
  createChildIssueSchema,
  createIssueSchema,
  draftIssueFromPromptSchema,
  draftGrillFromPromptSchema,
  resolveCreateIssueStatusDefault,
  resolveIssueRecoveryActionSchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  upsertIssueFeedbackVoteSchema,
  linkIssueApprovalSchema,
  issueDocumentKeySchema,
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  rejectIssueThreadInteractionSchema,
  restoreIssueDocumentRevisionSchema,
  respondIssueThreadInteractionSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  updateIssueSchema,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  isDesignWorkProductType,
  normalizeIssueIdentifier as normalizeIssueReferenceIdentifier,
  type CompanySearchQuery,
  type CompanySearchResponse,
  type ExecutionWorkspace,
  type IssueRelationIssueSummary,
  type SuccessfulRunHandoffState,
  resolvePlanReportLanguageLabel,
} from "@workcell/shared";
import { trackAgentTaskCompleted } from "@workcell/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import * as serviceIndex from "../services/index.js";
import {
  accessService,
  agentService,
  companyService,
  companySearchService,
  executionWorkspaceService,
  goalService,
  heartbeatService,
  issueApprovalService,
  issueRecoveryActionService,
  issueThreadInteractionService,
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_MAX_LIMIT,
  issueReferenceService,
  issueRequiresProofForDone,
  issueService,
  clampIssueListLimit,
  compoundFollowupService,
  documentService,
  logActivity,
  projectService,
  routineService,
  workProductService,
  designFlowService,
  deriveIssueDesignGate,
  extractDesignSystem,
  designSystemToDataUrl,
  refreshIssueContinuationSummary,
  renderSianToPng,
  EmptySianHtmlError,
} from "../services/index.js";
import { resolveWorkcellInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { conflict, forbidden, HttpError, notFound, unauthorized, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectIssueWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import {
  isInlineAttachmentContentType,
  normalizeIssueAttachmentMaxBytes,
  normalizeContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { buildMojibakeRejection } from "../services/text-encoding-guard.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { executionWorkspaceService as executionWorkspaceServiceDirect } from "../services/execution-workspaces.js";
import { feedbackService } from "../services/feedback.js";
import { runAdapterSingleTurn } from "../services/adapter-single-turn.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { environmentService } from "../services/environments.js";
import { redactSensitiveText } from "../redaction.js";
import {
  createCompanySearchRateLimiter,
  type CompanySearchRateLimiter,
} from "../services/company-search-rate-limit.js";
import {
  defaultLlmRouteRateLimiter,
  enforceLlmRouteRateLimit,
  type LlmRouteRateLimiter,
} from "../services/llm-route-rate-limit.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  redactIssueMonitorExternalRef,
  setIssueExecutionPolicyMonitorScheduledBy,
  stageIsUserOnly,
} from "../services/issue-execution-policy.js";
import { parseIssueExecutionWorkspaceSettings } from "../services/execution-workspace-policy.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
});

type ParsedExecutionState = NonNullable<ReturnType<typeof parseIssueExecutionState>>;
type NormalizedExecutionPolicy = NonNullable<ReturnType<typeof normalizeIssueExecutionPolicy>>;
type IssueRouteSnapshot = typeof issueRows.$inferSelect;
type RecoveryRevalidationTrigger =
  | "issue_update"
  | "comment"
  | "document"
  | "work_product"
  | "read_projection";
type CompanySearchService = {
  search(companyId: string, query: CompanySearchQuery): Promise<CompanySearchResponse>;
};
type ActivityIssueRelationSummary = {
  id: string;
  identifier: string | null;
  title: string;
};
type ActivityExecutionParticipant = Pick<
  NormalizedExecutionPolicy["stages"][number]["participants"][number],
  "type" | "agentId" | "userId"
>;
type ExecutionStageWakeContext = {
  wakeRole: "reviewer" | "approver" | "executor";
  stageId: string | null;
  stageType: ParsedExecutionState["currentStageType"];
  currentParticipant: ParsedExecutionState["currentParticipant"];
  returnAssignee: ParsedExecutionState["returnAssignee"];
  reviewRequest: ParsedExecutionState["reviewRequest"];
  lastDecisionOutcome: ParsedExecutionState["lastDecisionOutcome"];
  allowedActions: string[];
};
type SuccessfulRunHandoffActivityRow = {
  entityId: string;
  action: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
};

function applyCreateIssueStatusDefault(req: Request, res: Response, next: () => void) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    next();
    return;
  }

  const resolution = resolveCreateIssueStatusDefault(req.body as Record<string, unknown>);
  res.locals.createIssueStatusDefault = resolution;
  if (resolution.defaulted) {
    req.body = {
      ...req.body,
      status: resolution.status,
    };
  }
  next();
}

const PLANNER_CAPABLE_ROLES = new Set(["planner", "pm", "orchestrator"]);

// An agent is eligible to draft if it can be assigned work. This mirrors the
// system's own assignability rule (issues.ts assertAssignableAgent): agents that
// are pending approval or terminated cannot own work. agentService.list already
// drops terminated agents, so we only additionally exclude pending_approval here.
// Note: newly created agents default to status "idle" (not "active"), so we must
// not require status === "active" or we would reject every fresh planner.
function isDraftEligibleAgent(status: string | null | undefined): boolean {
  return status !== "pending_approval" && status !== "terminated";
}

// Resolve the agent that should draft a planner issue. Prefer the first eligible
// agent whose role is planner/pm/orchestrator (case-insensitive); otherwise, if exactly one
// eligible agent exists, use it. Returns null when nothing is suitable.
function resolvePlannerCapableAgentId(
  agents: Array<{ id: string; role?: string | null; status?: string | null }>,
): string | null {
  const eligible = agents.filter((agent) => isDraftEligibleAgent(agent.status));
  const roleMatch = eligible.find((agent) =>
    PLANNER_CAPABLE_ROLES.has(String(agent.role ?? "").trim().toLowerCase()),
  );
  if (roleMatch) return roleMatch.id;
  if (eligible.length === 1) return eligible[0].id;
  return null;
}

const QA_REVIEWER_ROLES = new Set(["qa"]);

// Resolve an eligible QA-role agent to act as the default reviewer, excluding a
// given agent so an executor never reviews its own work. Eligibility mirrors the
// planner resolver (agentService.list already drops terminated agents; we also
// exclude pending_approval). Returns null when no suitable QA agent exists.
function resolveQaReviewerAgentId(
  agents: Array<{ id: string; role?: string | null; status?: string | null }>,
  excludeAgentId: string | null,
): string | null {
  const candidate = agents.find(
    (agent) =>
      isDraftEligibleAgent(agent.status) &&
      agent.id !== excludeAgentId &&
      QA_REVIEWER_ROLES.has(String(agent.role ?? "").trim().toLowerCase()),
  );
  return candidate?.id ?? null;
}

// Default QA signoff: a single review stage owned by the resolved QA agent. The
// execution-policy machine reroutes the executor's "done" to in_review; the QA
// reviewer's approval is what actually completes the issue.
function buildDefaultQaReviewPolicy(qaReviewerAgentId: string) {
  return {
    stages: [{ type: "review", participants: [{ type: "agent", agentId: qaReviewerAgentId }] }],
  };
}

// Workcell philosophy: the Orchestrator turns board direction into issues and
// routes them to the right owner. When the board creates a top-level issue
// without picking an assignee, default it to the company's orchestrator so the
// board never has to hand-route work. Resolution: oldest (createdAt asc)
// eligible agent with role "orchestrator"; fall back to role "lead"; else null.
// Eligibility mirrors the planner/QA resolvers (agentService.list already drops
// terminated agents; we additionally exclude pending_approval).
function resolveDefaultOrchestratorAgentId(
  agents: Array<{
    id: string;
    role?: string | null;
    status?: string | null;
    createdAt?: Date | string | null;
  }>,
): string | null {
  const eligible = agents
    .filter((agent) => isDraftEligibleAgent(agent.status))
    .sort(
      (a, b) =>
        new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
    );
  for (const role of ["orchestrator", "lead"]) {
    const match = eligible.find(
      (agent) => String(agent.role ?? "").trim().toLowerCase() === role,
    );
    if (match) return match.id;
  }
  return null;
}

// WC-211 (finding 2 — UX): derive a CLEAN, short issue title from the draft
// prompt. The full prompt still drives the planner instruction (description) —
// this is only the human-facing title in lists/board. A long multi-line prompt
// would otherwise become an ugly full-paragraph title, so we: take the first
// line, collapse internal whitespace, cap at ~70 chars, and when we truncate we
// drop the trailing PARTIAL word (cut at the last space) before appending "…".
function buildPlannerDraftTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() || prompt.trim();
  const maxLength = 70;
  const condensed = firstLine.replace(/\s+/g, " ").trim();
  if (condensed.length === 0) return "Untitled draft";
  if (condensed.length <= maxLength) return condensed;
  // Truncate at the word boundary nearest the limit so we never end on a partial
  // word; fall back to a hard cut when the first "word" is itself longer than the
  // budget (no space to break on).
  const hardSlice = condensed.slice(0, maxLength);
  const lastSpace = hardSlice.lastIndexOf(" ");
  const truncated = lastSpace > 0 ? hardSlice.slice(0, lastSpace) : hardSlice;
  return `${truncated.trimEnd()}…`;
}

export function buildPlannerDraftInstruction(
  prompt: string,
  languageLabel?: string | null,
): string {
  const lines = [
    "You are drafting a structured issue from the request below. Do not write code or perform implementation work — produce the draft only.",
    "",
    "Write your result by PUT-ing markdown to the issue document with key `issue-draft` (route `PUT /issues/:id/documents/issue-draft`, format `markdown`).",
    "The document MUST contain exactly these four sections, each as a level-2 heading:",
    "## Acceptance Criteria",
    "## Non-Goals",
    "## Proof Surface",
    "## Suggested Owner Role",
    "",
    "Fill each section concretely based on the request. For \"Suggested Owner Role\", name the agent role best suited to own the work (e.g. engineer, designer, qa, devops, researcher, pm).",
  ];
  // WC-81: the board can pick a plan-report language at onboarding. When set
  // (non-English), instruct the planner to write the body in that language but
  // keep the four headings in English so the draft can still be parsed.
  if (languageLabel) {
    lines.push(
      "",
      `Write the body text of every section in ${languageLabel}. Keep the four section headings exactly as shown above (in English) so they can be parsed automatically; translate only the content beneath them.`,
    );
  }
  lines.push("", "Request:", prompt);
  return lines.join("\n");
}

// WC-184 (CP0 "Grill mode"): one clarifying question with its recommended answer.
export type PlannerGrillQuestion = {
  question: string;
  recommendation: string;
  rationale: string;
};

// WC-184: build the instruction that asks the planner to RETURN a short JSON
// list of the highest-leverage clarifying questions for the user's request —
// NOT a draft. Each item carries a recommended answer + a one-line rationale so
// the user can accept the recommendation or override it before drafting. The
// language directive mirrors buildPlannerDraftInstruction (WC-81): when a
// non-English plan-report language is set, the question/recommendation/rationale
// text is written in that language while the JSON keys stay in English so the
// reply parses deterministically.
export function buildPlannerGrillInstruction(
  prompt: string,
  languageLabel?: string | null,
): string {
  const lines = [
    "You are helping clarify a feature request BEFORE any issue is drafted. Do NOT draft an issue, write code, or perform implementation work.",
    "",
    "Interrogate the request: identify the highest-leverage ambiguities and decision-tree branches that would change how the work is scoped or executed. Ask only about things that genuinely matter — skip questions whose answer is obvious from the request.",
    "Prefer 5 questions or fewer. Order them most-important first.",
    "",
    "For EACH question, also provide your own recommended answer (the choice you would make as the planner) and a one-line rationale for that recommendation.",
    "",
    "Reply with ONLY a JSON array (no prose, no markdown fences) of objects with exactly these keys:",
    '  [{ "question": string, "recommendation": string, "rationale": string }]',
    "If the request is already fully specified and you have no genuine clarifying questions, reply with an empty array: []",
  ];
  if (languageLabel) {
    lines.push(
      "",
      `Write the question, recommendation, and rationale text in ${languageLabel}. Keep the JSON structure and the keys (question, recommendation, rationale) exactly as shown above (in English) so the reply can be parsed automatically.`,
    );
  }
  lines.push("", "Request:", prompt);
  return lines.join("\n");
}

// WC-184: robustly extract the grill questions from a model reply. The model is
// instructed to emit a bare JSON array, but real adapters wrap output in prose,
// ```json fences, or trailing chatter — so we tolerate all of that: pull the
// first balanced [...] block, JSON.parse it, and keep only well-formed
// { question, recommendation, rationale } objects. Any malformed / missing /
// non-array reply yields an empty list so the route never 500s on a bad reply.
export function parsePlannerGrillQuestions(raw: string): PlannerGrillQuestion[] {
  if (typeof raw !== "string") return [];
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) candidates.push(trimmed);
  // Pull the first top-level JSON array, scanning for a balanced bracket pair so
  // a leading "Here are the questions:" preamble or a trailing sign-off is fine.
  const start = raw.indexOf("[");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(raw.slice(start, i + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const questions: PlannerGrillQuestion[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const question = typeof record.question === "string" ? record.question.trim() : "";
      if (question.length === 0) continue;
      const recommendation =
        typeof record.recommendation === "string" ? record.recommendation.trim() : "";
      const rationale = typeof record.rationale === "string" ? record.rationale.trim() : "";
      questions.push({ question, recommendation, rationale });
    }
    return questions;
  }
  return [];
}

// WC-19 (D19 LLM auto-fill): build the child planning-issue title that points
// at the parent for whose compound-checklist we're filling.
function buildCompoundFillTitle(parentIdentifier: string, parentTitle: string): string {
  const t = parentTitle.replace(/\s+/g, " ").trim().slice(0, 80);
  return `Fill compound checklist for ${parentIdentifier} — ${t}`.slice(0, 160);
}

// WC-19: instruction prompt for the Planner-capable agent. The agent must
// keep the human-driven section 5 (Follow-up issues) untouched and only
// fill in sections 1–4 using whatever context is available (issue
// description, attached proof, comments). The agent writes by PUTing the
// updated full body back to the parent's compound-checklist document.
function buildCompoundFillInstruction(input: {
  parentIssueId: string;
  parentIdentifier: string;
  parentTitle: string;
  existingChecklistBody: string;
}): string {
  return [
    `You are filling in the post-completion compound checklist for issue ${input.parentIdentifier} ("${input.parentTitle}").`,
    "Do NOT write code or perform new implementation work — you are reviewing and summarizing what already happened.",
    "",
    "Read the parent issue's available context (description, comments, proof bundle, recent activity). Then write a complete updated checklist body and save it.",
    "",
    `Route: PUT /issues/${input.parentIssueId}/documents/compound-checklist (format \`markdown\`).`,
    "Send the FULL document body — your output replaces the existing body.",
    "",
    "The body MUST keep all 5 numbered section headings exactly as they are:",
    "  ## 1. What changed?",
    "  ## 2. Reusable learnings",
    "  ## 3. Prevention rules",
    "  ## 4. Failed approaches (kept for next time)",
    "  ## 5. Follow-up issues",
    "",
    "Fill in sections 1–4 with concrete, terse bullets specific to this issue.",
    "Section 5 is HUMAN-DRIVEN — copy it through verbatim from the existing body without changes (do not invent follow-ups).",
    "Keep each bullet under one sentence. Be honest about what didn't work.",
    "",
    "Existing checklist body (your starting point — preserve section 5 exactly):",
    "```markdown",
    input.existingChecklistBody,
    "```",
  ].join("\n");
}

function buildCreateIssueActivityStatusDetails(
  issue: { assigneeAgentId: string | null; status: string },
  res: Response,
) {
  const statusDefault = res.locals.createIssueStatusDefault as
    | ReturnType<typeof resolveCreateIssueStatusDefault>
    | undefined;
  const assignmentWakeSkipped = !issue.assigneeAgentId || issue.status === "backlog";
  return {
    status: issue.status,
    statusDefaulted: statusDefault?.defaulted ?? false,
    statusDefaultReason: statusDefault?.reason ?? "explicit",
    assignmentWakeSkipped,
    assignmentWakeSkipReason: assignmentWakeSkipped
      ? issue.assigneeAgentId
        ? "assigned_backlog"
        : "no_agent_assignee"
      : null,
  };
}

const SUCCESSFUL_RUN_HANDOFF_ACTIONS = [
  "issue.successful_run_handoff_required",
  "issue.successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated",
] as const;

const ISSUE_WORKSPACE_AUDIT_FIELDS = new Set([
  "projectWorkspaceId",
  "executionWorkspaceId",
  "executionWorkspacePreference",
  "executionWorkspaceSettings",
]);

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasIssueWorkspaceAuditChange(previous: Record<string, unknown>) {
  return Object.keys(previous).some((key) => ISSUE_WORKSPACE_AUDIT_FIELDS.has(key));
}

function labelIssueWorkspaceMode(mode: string | null) {
  switch (mode) {
    case "shared_workspace":
      return "Project default";
    case "isolated_workspace":
      return "New isolated workspace";
    case "operator_branch":
      return "Operator branch";
    case "reuse_existing":
      return "Reuse existing workspace";
    case "agent_default":
      return "Agent default";
    case "inherit":
      return "Inherited workspace";
    default:
      return "No workspace";
  }
}

type IssueWorkspaceAuditInput = {
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: unknown;
};

type WorkspaceNameMaps = {
  projectWorkspaceNames: Map<string, string>;
  executionWorkspaceNames: Map<string, string>;
};

function emptyWorkspaceNameMaps(): WorkspaceNameMaps {
  return {
    projectWorkspaceNames: new Map(),
    executionWorkspaceNames: new Map(),
  };
}

function summarizeIssueWorkspaceForActivity(
  issue: IssueWorkspaceAuditInput,
  names: WorkspaceNameMaps,
) {
  const settings = parseIssueExecutionWorkspaceSettings(issue.executionWorkspaceSettings);
  const mode = settings?.mode ?? issue.executionWorkspacePreference ?? null;
  const executionWorkspaceId = issue.executionWorkspaceId ?? null;
  const projectWorkspaceId = issue.projectWorkspaceId ?? null;

  const label = (() => {
    if (executionWorkspaceId) {
      return names.executionWorkspaceNames.get(executionWorkspaceId) ?? `Workspace ${executionWorkspaceId.slice(0, 8)}`;
    }
    if (projectWorkspaceId) {
      return names.projectWorkspaceNames.get(projectWorkspaceId) ?? `Workspace ${projectWorkspaceId.slice(0, 8)}`;
    }
    return labelIssueWorkspaceMode(mode);
  })();

  return {
    label,
    projectWorkspaceId,
    executionWorkspaceId,
    mode,
  };
}

async function buildIssueWorkspaceChangeActivityDetails(
  db: Db,
  companyId: string,
  previousIssue: IssueWorkspaceAuditInput,
  nextIssue: IssueWorkspaceAuditInput,
) {
  const projectWorkspaceIds = [
    previousIssue.projectWorkspaceId,
    nextIssue.projectWorkspaceId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const executionWorkspaceIds = [
    previousIssue.executionWorkspaceId,
    nextIssue.executionWorkspaceId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const [projectRows, executionRows] = await Promise.all([
    projectWorkspaceIds.length > 0
      ? db
          .select({ id: projectWorkspaces.id, name: projectWorkspaces.name })
          .from(projectWorkspaces)
          .where(and(eq(projectWorkspaces.companyId, companyId), inArray(projectWorkspaces.id, projectWorkspaceIds)))
      : Promise.resolve([]),
    executionWorkspaceIds.length > 0
      ? db
          .select({ id: executionWorkspaces.id, name: executionWorkspaces.name })
          .from(executionWorkspaces)
          .where(and(eq(executionWorkspaces.companyId, companyId), inArray(executionWorkspaces.id, executionWorkspaceIds)))
      : Promise.resolve([]),
  ]);

  const names: WorkspaceNameMaps = {
    projectWorkspaceNames: new Map(projectRows.map((row) => [row.id, row.name])),
    executionWorkspaceNames: new Map(executionRows.map((row) => [row.id, row.name])),
  };

  return {
    from: summarizeIssueWorkspaceForActivity(previousIssue, names),
    to: summarizeIssueWorkspaceForActivity(nextIssue, names),
  };
}

function hasExecutionParticipant(value: unknown) {
  const state = parseIssueExecutionState(value);
  if (!state || state.status !== "pending") return false;
  const participant = state.currentParticipant;
  if (!participant) return false;
  if (participant.type === "agent") return Boolean(participant.agentId);
  if (participant.type === "user") return Boolean(participant.userId);
  return false;
}

function hasScheduledMonitor(input: {
  existingMonitorNextCheckAt?: Date | null;
  patchMonitorNextCheckAt?: unknown;
  executionPolicy?: unknown;
}) {
  if (input.patchMonitorNextCheckAt instanceof Date && !Number.isNaN(input.patchMonitorNextCheckAt.getTime())) return true;
  if (input.patchMonitorNextCheckAt === undefined && input.existingMonitorNextCheckAt) return true;
  const policy = normalizeIssueExecutionPolicy(input.executionPolicy ?? null);
  return Boolean(policy?.monitor?.nextCheckAt);
}

function successfulRunHandoffStateFromActivity(row: {
  action: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}): SuccessfulRunHandoffState | null {
  const details = row.details ?? {};
  const state =
    row.action === "issue.successful_run_handoff_required"
      ? "required"
      : row.action === "issue.successful_run_handoff_resolved"
        ? "resolved"
        : row.action === "issue.successful_run_handoff_escalated"
          ? "escalated"
          : null;
  if (!state) return null;

  const detectedProgressSummary =
    readNonEmptyString(details.detectedProgressSummary)
    ?? readNonEmptyString(details.detected_progress_summary)
    ?? null;

  return {
    state,
    required: state === "required",
    sourceRunId:
      readNonEmptyString(details.sourceRunId)
      ?? readNonEmptyString(details.source_run_id)
      ?? readNonEmptyString(details.resumeFromRunId)
      ?? row.runId
      ?? null,
    correctiveRunId:
      readNonEmptyString(details.correctiveRunId)
      ?? readNonEmptyString(details.corrective_run_id)
      ?? (state !== "required" ? row.runId : null),
    assigneeAgentId:
      readNonEmptyString(details.assigneeAgentId)
      ?? readNonEmptyString(details.agentId)
      ?? row.agentId
      ?? null,
    detectedProgressSummary: detectedProgressSummary
      ? redactSensitiveText(detectedProgressSummary)
      : null,
    createdAt: row.createdAt,
  };
}

async function listSuccessfulRunHandoffStates(
  db: Db,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, SuccessfulRunHandoffState>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .select({
      entityId: activityLog.entityId,
      action: activityLog.action,
      agentId: activityLog.agentId,
      runId: activityLog.runId,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, "issue"),
      inArray(activityLog.entityId, issueIds),
      inArray(activityLog.action, [...SUCCESSFUL_RUN_HANDOFF_ACTIONS]),
    ))
    .orderBy(activityLog.entityId, desc(activityLog.createdAt), desc(activityLog.id)) as SuccessfulRunHandoffActivityRow[];

  const states = new Map<string, SuccessfulRunHandoffState>();
  for (const row of rows) {
    if (states.has(row.entityId)) continue;
    const state = successfulRunHandoffStateFromActivity(row);
    if (state) states.set(row.entityId, state);
  }
  return states;
}

type RecoveryActionsLister = {
  listActiveForIssues: (
    companyId: string,
    sourceIssueIds: string[],
  ) => Promise<Map<string, NonNullable<IssueRelationIssueSummary["activeRecoveryAction"]>>>;
};

async function relationRecoveryActionMap(
  recoveryActionsSvc: RecoveryActionsLister,
  companyId: string,
  relations: { blockedBy: IssueRelationIssueSummary[]; blocks: IssueRelationIssueSummary[] },
): Promise<Map<string, NonNullable<IssueRelationIssueSummary["activeRecoveryAction"]>>> {
  const candidates: IssueRelationIssueSummary[] = [];
  const visit = (summary: IssueRelationIssueSummary) => {
    candidates.push(summary);
    for (const terminal of summary.terminalBlockers ?? []) {
      visit(terminal);
    }
  };
  for (const blocker of relations.blockedBy) visit(blocker);
  for (const blocking of relations.blocks) visit(blocking);
  if (candidates.length === 0) return new Map();
  const ids = [...new Set(candidates.map((summary) => summary.id))];
  return recoveryActionsSvc.listActiveForIssues(companyId, ids);
}

function withRecoveryActionsOnRelationSummaries(
  relations: { blockedBy: IssueRelationIssueSummary[]; blocks: IssueRelationIssueSummary[] },
  recoveryActionByIssueId: Map<string, NonNullable<IssueRelationIssueSummary["activeRecoveryAction"]>>,
) {
  const augment = (summary: IssueRelationIssueSummary): IssueRelationIssueSummary => ({
    ...summary,
    activeRecoveryAction: recoveryActionByIssueId.get(summary.id) ?? summary.activeRecoveryAction ?? null,
    terminalBlockers: summary.terminalBlockers?.map(augment),
  });
  return {
    blockedBy: relations.blockedBy.map(augment),
    blocks: relations.blocks.map(augment),
  };
}

const ACTIVE_REVIEW_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);

const INVALID_AGENT_IN_REVIEW_DISPOSITION_MESSAGE =
  "invalid_issue_disposition: Agent-authored updates that move an issue to in_review must include a real review path. " +
  "This request would leave the issue in_review without anyone or anything owning the next action. " +
  "Keep working instead of moving to review, create a request_confirmation or ask_user_questions interaction, " +
  "link or request a pending approval, assign a human reviewer with assigneeUserId, set a typed executionState.currentParticipant through an execution policy, " +
  "or schedule an issue monitor for an external review/check. After creating one of those review paths, retry the status update.";

function executionPrincipalsEqual(
  left: ParsedExecutionState["currentParticipant"] | null,
  right: ParsedExecutionState["currentParticipant"] | null,
) {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === "agent" ? left.agentId === right.agentId : left.userId === right.userId;
}

function buildExecutionStageWakeContext(input: {
  state: ParsedExecutionState;
  wakeRole: ExecutionStageWakeContext["wakeRole"];
  allowedActions: string[];
}): ExecutionStageWakeContext {
  return {
    wakeRole: input.wakeRole,
    stageId: input.state.currentStageId,
    stageType: input.state.currentStageType,
    currentParticipant: input.state.currentParticipant,
    returnAssignee: input.state.returnAssignee,
    reviewRequest: input.state.reviewRequest ?? null,
    lastDecisionOutcome: input.state.lastDecisionOutcome,
    allowedActions: input.allowedActions,
  };
}

function summarizeIssueRelationForActivity(relation: {
  id: string;
  identifier: string | null;
  title: string;
}): ActivityIssueRelationSummary {
  return {
    id: relation.id,
    identifier: relation.identifier,
    title: relation.title,
  };
}

const defaultCompanySearchRateLimiter = createCompanySearchRateLimiter();

function companySearchRateLimitActor(req: Request, companyId: string) {
  if (req.actor.type === "agent") {
    return {
      companyId,
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? req.actor.keyId ?? "unknown-agent",
    };
  }
  return {
    companyId,
    actorType: "board" as const,
    actorId: req.actor.userId ?? req.actor.source ?? "board",
  };
}

function summarizeIssueReferenceActivityDetails(input:
  | {
      addedReferencedIssues: ActivityIssueRelationSummary[];
      removedReferencedIssues: ActivityIssueRelationSummary[];
      currentReferencedIssues: ActivityIssueRelationSummary[];
    }
  | null
  | undefined,
) {
  if (!input) return {};
  return {
    ...(input.addedReferencedIssues.length > 0 ? { addedReferencedIssues: input.addedReferencedIssues } : {}),
    ...(input.removedReferencedIssues.length > 0 ? { removedReferencedIssues: input.removedReferencedIssues } : {}),
    ...(input.currentReferencedIssues.length > 0 ? { currentReferencedIssues: input.currentReferencedIssues } : {}),
  };
}

function monitorPoliciesEqual(left: NormalizedExecutionPolicy | null, right: NormalizedExecutionPolicy | null) {
  return JSON.stringify(left?.monitor ?? null) === JSON.stringify(right?.monitor ?? null);
}

function applyActorMonitorScheduledBy(
  policy: NormalizedExecutionPolicy | null,
  actorType: "agent" | "user",
) {
  return setIssueExecutionPolicyMonitorScheduledBy(policy, actorType === "user" ? "board" : "assignee");
}

function assertCanManageIssueMonitor(req: Request, assigneeAgentId: string | null, monitorChanged: boolean) {
  if (!monitorChanged) return;
  if (req.actor.type === "board") return;
  if (req.actor.type === "agent" && req.actor.agentId && req.actor.agentId === assigneeAgentId) return;
  throw forbidden("Only the assignee agent or a board user can manage issue monitors");
}

function summarizeIssueMonitor(
  issue: {
    monitorNextCheckAt?: Date | null;
    monitorLastTriggeredAt?: Date | null;
    monitorAttemptCount?: number | null;
    monitorNotes?: string | null;
    monitorScheduledBy?: string | null;
    executionState?: unknown;
  },
  policy: NormalizedExecutionPolicy | null,
) {
  const state = parseIssueExecutionState(issue.executionState);
  return {
    nextCheckAt: issue.monitorNextCheckAt?.toISOString() ?? policy?.monitor?.nextCheckAt ?? null,
    lastTriggeredAt: issue.monitorLastTriggeredAt?.toISOString() ?? state?.monitor?.lastTriggeredAt ?? null,
    attemptCount: issue.monitorAttemptCount ?? state?.monitor?.attemptCount ?? 0,
    notes: policy?.monitor?.notes ?? issue.monitorNotes ?? state?.monitor?.notes ?? null,
    scheduledBy: issue.monitorScheduledBy ?? policy?.monitor?.scheduledBy ?? state?.monitor?.scheduledBy ?? null,
    kind: policy?.monitor?.kind ?? state?.monitor?.kind ?? null,
    serviceName: policy?.monitor?.serviceName ?? state?.monitor?.serviceName ?? null,
    externalRef: redactIssueMonitorExternalRef(policy?.monitor?.externalRef ?? state?.monitor?.externalRef ?? null),
    timeoutAt: policy?.monitor?.timeoutAt ?? state?.monitor?.timeoutAt ?? null,
    maxAttempts: policy?.monitor?.maxAttempts ?? state?.monitor?.maxAttempts ?? null,
    recoveryPolicy: policy?.monitor?.recoveryPolicy ?? state?.monitor?.recoveryPolicy ?? null,
    status: state?.monitor?.status ?? (policy?.monitor ? "scheduled" : null),
    clearReason: state?.monitor?.clearReason ?? null,
  };
}

function activityExecutionParticipantKey(participant: ActivityExecutionParticipant): string {
  return participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
}

function summarizeExecutionParticipants(
  policy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
): ActivityExecutionParticipant[] {
  const stage = policy?.stages.find((candidate) => candidate.type === stageType);
  return (
    stage?.participants.map((participant) => ({
      type: participant.type,
      agentId: participant.agentId ?? null,
      userId: participant.userId ?? null,
    })) ?? []
  );
}

function isClosedIssueStatus(status: string | null | undefined): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

function shouldImplicitlyMoveCommentedIssueToTodo(input: {
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
}) {
  // Only human comments should implicitly reopen finished work.
  // Agent-authored comments remain communicative unless reopen was explicit.
  // CANCELLED is deliberately excluded: the board killed the work, and a
  // comment on it (often "stop doing this") must stay a comment — implicitly
  // reviving the issue turned stop-work direction into a restart. Explicit
  // reopen (the UI's reopen action) still works on cancelled issues.
  if (input.actorType !== "user") return false;
  if (input.issueStatus !== "done" && input.issueStatus !== "blocked") return false;
  if (typeof input.assigneeAgentId !== "string" || input.assigneeAgentId.length === 0) return false;
  return true;
}

function shouldHumanCommentResumeInProgressScheduledRetry(input: {
  hasComment: boolean;
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
}) {
  if (!input.hasComment) return false;
  if (input.actorType !== "user") return false;
  if (input.issueStatus !== "in_progress") return false;
  return typeof input.assigneeAgentId === "string" && input.assigneeAgentId.length > 0;
}

function isExplicitResumeCapableStatus(status: string | null | undefined) {
  return status === "done" || status === "blocked" || status === "todo" || status === "in_progress";
}

function queueResolvedInteractionContinuationWakeup(input: {
  heartbeat: ReturnType<typeof heartbeatService>;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  interaction: {
    id: string;
    kind: string;
    status: string;
    continuationPolicy: string;
    sourceCommentId?: string | null;
    sourceRunId?: string | null;
  };
  actor: { actorType: "user" | "agent"; actorId: string };
  source: string;
  forceFreshSession?: boolean;
  workspaceRefreshReason?: string | null;
}) {
  if (
    input.interaction.continuationPolicy !== "wake_assignee"
    && input.interaction.continuationPolicy !== "wake_assignee_on_accept"
  ) return;
  if (
    input.interaction.continuationPolicy === "wake_assignee_on_accept"
    && input.interaction.status !== "accepted"
    // An explicit board REJECTION must wake the assignee even under
    // wake_assignee_on_accept: the rejection reason is actionable feedback the
    // agent has to address — silently dropping it left the board waiting on an
    // agent that was never told. Only expiry/supersede stays quiet.
    && input.interaction.status !== "rejected"
  ) return;
  if (input.interaction.status === "expired") return;
  if (!input.issue.assigneeAgentId || isClosedIssueStatus(input.issue.status)) return;

  const forceFreshSession = input.forceFreshSession === true;
  const workspaceRefreshReason = readNonEmptyString(input.workspaceRefreshReason);
  void input.heartbeat.wakeup(input.issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: {
      issueId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      mutation: "interaction",
    },
    requestedByActorType: input.actor.actorType,
    requestedByActorId: input.actor.actorId,
    contextSnapshot: {
      issueId: input.issue.id,
      taskId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      wakeReason: "issue_commented",
      source: input.source,
      ...(forceFreshSession ? { forceFreshSession: true } : {}),
      ...(workspaceRefreshReason ? { workspaceRefreshReason } : {}),
    },
  }).catch((err) => logger.warn({
    err,
    issueId: input.issue.id,
    interactionId: input.interaction.id,
    agentId: input.issue.assigneeAgentId,
  }, "failed to wake assignee on issue interaction resolution"));
}

// Board design-review decisions must wake the assignee: approving a 시안 is
// the green light the issue has been waiting on (finish the review stage /
// start building), and changes-requested is feedback the designer must act
// on. Without this, LOR-7-style issues sat in in_review forever after the
// board approved the design — the decision landed on nobody.
function queueDesignReviewResolutionWakeup(input: {
  heartbeat: ReturnType<typeof heartbeatService>;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  workProductId: string;
  decision: "approved" | "changes_requested";
  actor: { actorType: "user" | "agent"; actorId: string };
  // The decision comment (with the board's reason). Riding the wake as the
  // wake comment puts the reason IN the agent's task prompt — without it the
  // reason only lived in the activity log and every change request cost the
  // agent minutes of API archaeology to find out WHAT to change.
  commentId?: string | null;
  // changes_requested ONLY: the designer to re-engage on the 시안. Design
  // rework is the DESIGNER's job — but during in_review issue.assigneeAgentId
  // is the QA reviewer, so waking the assignee made QA redo the design. When a
  // designer is resolved (the open design_request child's assignee, else a
  // designer-role agent), wake THEM instead. Null → fall back to the assignee
  // wake (no designer in the company).
  designerAgentId?: string | null;
}) {
  // Re-engage the designer on a change request (not the QA reviewer who happens
  // to hold the issue during in_review).
  if (input.decision === "changes_requested" && input.designerAgentId) {
    void input.heartbeat.wakeup(input.designerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId: input.issue.id,
        designReviewWorkProductId: input.workProductId,
        designReviewDecision: input.decision,
        mutation: "design_review",
        ...(input.commentId ? { commentId: input.commentId } : {}),
      },
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId,
      contextSnapshot: {
        issueId: input.issue.id,
        taskId: input.issue.id,
        designReviewWorkProductId: input.workProductId,
        designReviewDecision: input.decision,
        wakeReason: "issue_commented",
        source: "issue.design_changes_requested",
        ...(input.commentId ? { wakeCommentId: input.commentId, commentId: input.commentId } : {}),
      },
    }).catch((err) => logger.warn({
      err,
      issueId: input.issue.id,
      workProductId: input.workProductId,
      designerAgentId: input.designerAgentId,
    }, "failed to wake designer on design change request"));
    return;
  }
  if (!input.issue.assigneeAgentId || isClosedIssueStatus(input.issue.status)) return;
  void input.heartbeat.wakeup(input.issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: {
      issueId: input.issue.id,
      designReviewWorkProductId: input.workProductId,
      designReviewDecision: input.decision,
      mutation: "design_review",
      ...(input.commentId ? { commentId: input.commentId } : {}),
    },
    requestedByActorType: input.actor.actorType,
    requestedByActorId: input.actor.actorId,
    contextSnapshot: {
      issueId: input.issue.id,
      taskId: input.issue.id,
      designReviewWorkProductId: input.workProductId,
      designReviewDecision: input.decision,
      wakeReason: "issue_commented",
      source: "issue.design_review_resolved",
      ...(input.commentId ? { wakeCommentId: input.commentId, commentId: input.commentId } : {}),
    },
  }).catch((err) => logger.warn({
    err,
    issueId: input.issue.id,
    workProductId: input.workProductId,
  }, "failed to wake assignee on design review resolution"));
}

// Resolve which designer should redo a 시안 on a change request: the open
// design_request child's assignee first (the designer already on this screen),
// else any active designer-role agent. Returns null when the company has no
// designer — the caller then falls back to the assignee wake.
async function resolveDesignChangeDesigner(
  db: Db,
  companyId: string,
  parentIssueId: string,
): Promise<string | null> {
  const childDesigner = await db
    .select({ assigneeAgentId: issueRows.assigneeAgentId })
    .from(issueRows)
    .where(
      and(
        eq(issueRows.companyId, companyId),
        eq(issueRows.originKind, "design_request"),
        eq(issueRows.originId, parentIssueId),
        isNull(issueRows.hiddenAt),
        notInArray(issueRows.status, ["done", "cancelled"]),
      ),
    )
    .orderBy(desc(issueRows.createdAt))
    .limit(1)
    .then((rows) => rows[0]?.assigneeAgentId ?? null);
  if (childDesigner) return childDesigner;
  return db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.role, "designer"),
        notInArray(agents.status, ["terminated", "paused"]),
      ),
    )
    .orderBy(asc(agents.createdAt))
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);
}

// GAP 1: decode a `data:text/html` URL to its HTML string for the submit-time
// design conformance gate. Returns null for anything that is not a decodable
// data:text/html URL (live https links, image data URLs, malformed payloads),
// so the caller can skip the gate gracefully. PURE + total: never throws.
function decodeDataTextHtmlUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const match = /^data:text\/html(?<params>;[^,]*)?,(?<payload>[\s\S]*)$/i.exec(url);
  if (!match?.groups) return null;
  const isBase64 = /;base64/i.test(match.groups.params ?? "");
  const payload = match.groups.payload ?? "";
  try {
    if (isBase64) {
      return Buffer.from(payload, "base64").toString("utf8");
    }
    // Non-base64 data URLs are percent-encoded (designSystemToDataUrl uses
    // encodeURIComponent); decodeURIComponent reverses it. A bare unencoded
    // payload round-trips unchanged.
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

// Matches a served asset content URL — absolute or relative — of the form
// /api/assets/<uuid>/content. Recognizes the SHORT 시안 asset URL form that
// design_attach now writes instead of inlining the whole mockup as a data: URL.
const ASSET_CONTENT_URL_RE = /\/api\/assets\/([0-9a-fA-F-]{36})\/content(?:[/?#]|$)/;

// Hard cap on how much 시안 HTML we buffer into memory when resolving an asset
// URL. The upload path already bounds asset size; this is a second backstop so a
// corrupt/huge object cannot blow up the resolver.
const MAX_SIAN_HTML_BYTES = 16 * 1024 * 1024;

// Collect a Readable into a UTF-8 string, bailing to null if it exceeds maxBytes
// (rather than buffering unbounded memory). Never throws on size; stream errors
// propagate to the caller's try/catch.
async function readStreamToStringBounded(stream: Readable, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      stream.destroy();
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Resolve a 시안 work-product `url` to its raw HTML, supporting BOTH storage forms:
//   1. legacy inline data:text/html URLs (decoded in-process, no I/O), and
//   2. the new SHORT asset URL /api/assets/<id>/content (read from the storage
//      service IN-PROCESS — never via an outbound HTTP fetch).
// Total + never throws: a live https link, an image asset, a missing/oversized
// object, or a cross-company id all yield null, so the caller skips its
// gate/render exactly as it did for a non-decodable url before.
//
// SECURITY: asset lookup is global-by-id (NOT company-scoped). This resolver is
// safe ONLY behind an auth gate (assertAgentIssueMutationAllowed /
// assertCompanyAccess) — both call sites have one. When expectedCompanyId is
// given, an asset belonging to a different company is rejected (returns null) as
// defense-in-depth. NEVER wire this into an unauthenticated or cross-company
// HTTP path.
export async function resolveSianHtml(
  deps: {
    getAsset: (
      id: string,
    ) => Promise<{ companyId: string; objectKey: string; contentType: string | null } | null>;
    getObject: (companyId: string, objectKey: string) => Promise<{ stream: Readable }>;
  },
  url: string | null | undefined,
  expectedCompanyId?: string | null,
): Promise<string | null> {
  // Branch 1: legacy inline data:text/html (cheapest; no I/O).
  const inline = decodeDataTextHtmlUrl(url);
  if (inline !== null) return inline;
  if (typeof url !== "string") return null;

  // Branch 2: the short asset URL → read the stored HTML in-process.
  const match = ASSET_CONTENT_URL_RE.exec(url);
  if (!match) return null;
  const assetId = match[1];
  try {
    const asset = await deps.getAsset(assetId);
    if (!asset) return null;
    if (expectedCompanyId && asset.companyId !== expectedCompanyId) return null;
    const contentType = (asset.contentType ?? "").toLowerCase();
    if (!(contentType === "text/html" || contentType.startsWith("text/html;"))) return null;
    const object = await deps.getObject(asset.companyId, asset.objectKey);
    return await readStreamToStringBounded(object.stream, MAX_SIAN_HTML_BYTES);
  } catch {
    return null;
  }
}

// WC-DSR (designer visual self-review): cap how many times a single 시안 work
// product can bounce through the render → self-review → revise loop before the
// designer is allowed to submit anyway. Without a cap a designer that keeps
// "fixing" against the screenshot could re-render forever; after the cap we
// stop re-waking and let the submit gate proceed (with a logged note). The
// counter lives on the work product's metadata (designSelfReviewRounds).
const SIAN_SELF_REVIEW_ROUND_CAP = 3;
const SIAN_PREVIEW_SUBDIR = ".workcell-design-preview";

// Read the self-review round counter off a work product's metadata. Total +
// pure: any non-finite/absent value reads as 0.
function readSelfReviewRounds(metadata: Record<string, unknown> | null | undefined): number {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.designSelfReviewRounds;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

// Resolve the absolute path the rendered 시안 PNG should be written to. Prefer
// the issue's own execution-workspace cwd (the PNG then sits beside the work),
// falling back to a stable server-managed directory under the Workcell instance
// root when the issue has no realized workspace yet (common: a fresh design
// 시안 attached before any implementation run). Either way the path is absolute
// so a local agent process can Read it. `workProductId` is the stable file name
// so re-renders of the same 시안 overwrite in place.
function resolveSianPreviewPngPath(input: {
  workspaceCwd: string | null;
  issueId: string;
  workProductId: string;
}): string {
  const fileName = `${input.workProductId}.png`;
  if (input.workspaceCwd && input.workspaceCwd.trim().length > 0) {
    return path.resolve(input.workspaceCwd, SIAN_PREVIEW_SUBDIR, fileName);
  }
  // No workspace yet — write under <instanceRoot>/design-previews/<issueId>/.
  return path.resolve(resolveWorkcellInstanceRoot(), "design-previews", input.issueId, fileName);
}

function diffExecutionParticipants(
  previousPolicy: NormalizedExecutionPolicy | null,
  nextPolicy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
) {
  const previousParticipants = summarizeExecutionParticipants(previousPolicy, stageType);
  const nextParticipants = summarizeExecutionParticipants(nextPolicy, stageType);
  const previousByKey = new Map(previousParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));
  const nextByKey = new Map(nextParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));

  return {
    participants: nextParticipants,
    addedParticipants: nextParticipants.filter((participant) => !previousByKey.has(activityExecutionParticipantKey(participant))),
    removedParticipants: previousParticipants.filter((participant) => !nextByKey.has(activityExecutionParticipantKey(participant))),
  };
}

function buildExecutionStageWakeup(input: {
  issueId: string;
  previousState: ParsedExecutionState | null;
  nextState: ParsedExecutionState | null;
  interruptedRunId: string | null;
  requestedByActorType: "user" | "agent";
  requestedByActorId: string;
  // GAP 3: the id of the review-decision comment to ride on this wake so the
  // re-engaged agent's task prompt shows WHAT was requested. For the
  // changes_requested branch this is the implementer's change-request reason;
  // for the re-review (pending) branch it is the most recent change-request
  // comment so the reviewer re-engages with the prior feedback in hand. Null
  // when no decision comment is available — the wake omits it, byte-identical
  // to before.
  decisionCommentId?: string | null;
}) {
  const { issueId, previousState, nextState, interruptedRunId } = input;
  const decisionCommentId = input.decisionCommentId ?? null;
  if (!nextState) return null;

  if (nextState.status === "pending") {
    const agentId =
      nextState.currentParticipant?.type === "agent" ? (nextState.currentParticipant.agentId ?? null) : null;
    const stageChanged =
      previousState?.status !== "pending" ||
      previousState?.currentStageId !== nextState.currentStageId ||
      !executionPrincipalsEqual(previousState?.currentParticipant ?? null, nextState.currentParticipant ?? null);
    if (!agentId || !stageChanged) return null;

    const reason =
      nextState.currentStageType === "approval" ? "execution_approval_requested" : "execution_review_requested";
    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: nextState.currentStageType === "approval" ? "approver" : "reviewer",
      allowedActions: ["approve", "request_changes"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason,
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(decisionCommentId ? { commentId: decisionCommentId } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: reason,
          source: "issue.execution_stage",
          executionStage,
          ...(decisionCommentId ? { wakeCommentId: decisionCommentId, commentId: decisionCommentId } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  if (nextState.status === "changes_requested") {
    const agentId = nextState.returnAssignee?.type === "agent" ? (nextState.returnAssignee.agentId ?? null) : null;
    const becameChangesRequested =
      previousState?.status !== "changes_requested" ||
      previousState?.lastDecisionId !== nextState.lastDecisionId ||
      !executionPrincipalsEqual(previousState?.returnAssignee ?? null, nextState.returnAssignee ?? null);
    if (!agentId || !becameChangesRequested) return null;

    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: "executor",
      allowedActions: ["address_changes", "resubmit"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason: "execution_changes_requested",
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(decisionCommentId ? { commentId: decisionCommentId } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_changes_requested",
          source: "issue.execution_stage",
          executionStage,
          ...(decisionCommentId ? { wakeCommentId: decisionCommentId, commentId: decisionCommentId } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  return null;
}

export function issueRoutes(
  db: Db,
  storage: StorageService,
  opts: {
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    searchService?: CompanySearchService;
    searchRateLimiter?: CompanySearchRateLimiter;
    // WC-215: injectable per-tenant limiter for the expensive LLM routes
    // (draft-from-prompt, compound-checklist auto-fill, context compaction).
    // Tests pass a tiny-limit fake; production uses the shared default.
    llmRateLimiter?: LlmRouteRateLimiter;
    pluginWorkerManager?: PluginWorkerManager;
  } = {},
) {
  const router = Router();
  const svc = issueService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const feedback = feedbackService(db);
  const companiesSvc = companyService(db);
  let searchSvc = opts.searchService ?? null;
  const getSearchService = () => {
    searchSvc ??= companySearchService(db);
    return searchSvc;
  };
  const searchRateLimiter = opts.searchRateLimiter ?? defaultCompanySearchRateLimiter;
  const llmRateLimiter = opts.llmRateLimiter ?? defaultLlmRouteRateLimiter;
  const instanceSettings = instanceSettingsService(db);
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);

  // Resolve the execution policy to persist for a newly created issue (top-level or
  // child). Defaults the QA-review signoff for execution-mode issues that have no
  // explicit policy when an eligible QA agent exists; the QA agent lookup is lazy so
  // explicit-policy and planning creates never query agents. Returns the raw policy
  // input for the caller to normalize.
  async function resolveCreateExecutionPolicyInput(
    companyId: string,
    body: { executionPolicy?: unknown; workMode?: string | null; assigneeAgentId?: string | null },
  ): Promise<unknown> {
    if (body.executionPolicy !== undefined && body.executionPolicy !== null) return body.executionPolicy;
    if (body.workMode === "planning") return body.executionPolicy ?? null;
    // Defensive: a partially-mocked agentService in a downstream test may omit `.list`
    // entirely (the method itself is undefined). Optional-chain the call so the method
    // is never invoked if missing, and `?? []` covers a list() that returns nullish.
    // Runtime behavior: no agent list → no default policy injected (same as no-QA path).
    const qaReviewerId = resolveQaReviewerAgentId(
      (await agentsSvc.list?.(companyId)) ?? [],
      body.assigneeAgentId ?? null,
    );
    return qaReviewerId ? buildDefaultQaReviewPolicy(qaReviewerId) : (body.executionPolicy ?? null);
  }

  // WC-6: complete the WC-5 default-QA-signoff by also injecting on assignment.
  // The create-time injection misses the common UX flow of "create unassigned, assign
  // later" — and any existing issue whose company gains a QA agent after creation.
  // Returns a policy to inject only when:
  //   • the PATCH does not explicitly carry an executionPolicy,
  //   • the issue has no existing policy,
  //   • this PATCH sets a real agent assignee (not user/null/unchanged),
  //   • the issue is execution-mode (workMode !== "planning"),
  //   • an eligible QA agent (≠ the new assignee) exists.
  // Otherwise returns null. Mirrors the create-time helper's safe defaults
  // (agentsSvc.list is defended with ?? []; runtime behavior under a missing/empty
  // list is "no policy injected", same as no-QA-agent path).
  async function resolveAssignmentDefaultPolicy(input: {
    companyId: string;
    workMode: string | null | undefined;
    hasExistingPolicy: boolean;
    hasIncomingPolicy: boolean;
    newAssigneeAgentId: string | null | undefined;
  }): Promise<unknown | null> {
    if (input.hasIncomingPolicy) return null;
    if (input.hasExistingPolicy) return null;
    if (!input.newAssigneeAgentId) return null;
    if (input.workMode === "planning") return null;
    // Same partial-mock defense as resolveCreateExecutionPolicyInput — see note there.
    const qaReviewerId = resolveQaReviewerAgentId(
      (await agentsSvc.list?.(input.companyId)) ?? [],
      input.newAssigneeAgentId,
    );
    return qaReviewerId ? buildDefaultQaReviewPolicy(qaReviewerId) : null;
  }
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const executionWorkspacesSvc = executionWorkspaceServiceDirect(db);
  const workProductsSvc = workProductService(db);
  const designFlowSvc = designFlowService(db);
  const documentsSvc = documentService(db);
  const compoundFollowupsSvc = compoundFollowupService(db);
  const issueReferencesSvc = issueReferenceService(db);
  const issueThreadInteractionsSvc = issueThreadInteractionService(db);
  const routinesSvc = routineService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const issueTreeControlFactory = Object.prototype.hasOwnProperty.call(
    serviceIndex,
    "issueTreeControlService",
  )
    ? serviceIndex.issueTreeControlService
    : undefined;
  const treeControlSvc = issueTreeControlFactory?.(db) ?? {
    getActivePauseHoldGate: async () => null,
  };
  const feedbackExportService = opts?.feedbackExportService;
  const environmentsSvc = environmentService(db);

  async function cancelScheduledRetrySupersededByComment(input: {
    scheduledRetryRunId: string | null | undefined;
    issue: { id: string; companyId: string };
    actor: ReturnType<typeof getActorInfo>;
  }) {
    const scheduledRetryRunId = readNonEmptyString(input.scheduledRetryRunId);
    if (!scheduledRetryRunId) return null;

    try {
      const cancelled = await heartbeat.cancelRun(scheduledRetryRunId);
      const cancelledRunId = cancelled?.id ?? scheduledRetryRunId;
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: cancelledRunId,
        details: {
          source: "issue_comment_scheduled_retry_superseded",
          issueId: input.issue.id,
        },
      });
      return cancelledRunId;
    } catch (err) {
      logger.error(
        { err, issueId: input.issue.id, runId: scheduledRetryRunId },
        "failed to cancel scheduled retry superseded by issue comment",
      );
      throw err;
    }
  }

  async function classifySourceRecoveryRevalidation(input: {
    issue: IssueRouteSnapshot;
    trigger: RecoveryRevalidationTrigger;
    statusChanged?: boolean;
    assigneeChanged?: boolean;
    blockersChanged?: boolean;
    executionPolicyChanged?: boolean;
    monitorChanged?: boolean;
    documentChanged?: boolean;
    workProductChanged?: boolean;
    resumeRequested?: boolean;
    reopened?: boolean;
    blockedToTodoRecovery?: boolean;
  }): Promise<string | null> {
    const { issue } = input;
    if (issue.status === "done" || issue.status === "cancelled") {
      return `Recovery action became stale because the source issue reached ${issue.status}.`;
    }
    if (input.blockedToTodoRecovery === true) {
      return "Recovery action became stale because the source issue was manually moved from blocked to todo.";
    }

    if (input.trigger === "read_projection") return null;
    if (
      input.trigger === "comment" &&
      input.resumeRequested !== true &&
      input.reopened !== true &&
      input.statusChanged !== true
    ) {
      return null;
    }

    const durableSourceChange =
      input.statusChanged === true ||
      input.assigneeChanged === true ||
      input.blockersChanged === true ||
      input.executionPolicyChanged === true ||
      input.monitorChanged === true ||
      input.documentChanged === true ||
      input.workProductChanged === true ||
      input.resumeRequested === true ||
      input.reopened === true;
    if (!durableSourceChange) return null;

    if (issue.status === "blocked") {
      const readiness = await svc.getDependencyReadiness(issue.id);
      if (readiness.unresolvedBlockerCount > 0) {
        return "Recovery action became stale because the source issue now has unresolved first-class blockers.";
      }
      return null;
    }

    if (issue.assigneeUserId && issue.status !== "done" && issue.status !== "cancelled") {
      return "Recovery action became stale because the source issue now has a human owner.";
    }

    if ((issue.status === "todo" || issue.status === "in_progress") && issue.assigneeAgentId) {
      return `Recovery action became stale because the source issue is ${issue.status} with an agent owner.`;
    }

    if (issue.status === "in_review") {
      const executionState = parseIssueExecutionState(issue.executionState);
      const participant = executionState?.status === "pending" ? executionState.currentParticipant : null;
      if (
        (participant?.type === "agent" && readNonEmptyString(participant.agentId)) ||
        (participant?.type === "user" && readNonEmptyString(participant.userId))
      ) {
        return "Recovery action became stale because the source issue now has a typed review participant.";
      }

      const interactions = await issueThreadInteractionsSvc.listForIssue(issue.id);
      if (interactions.some((interaction) => interaction.status === "pending")) {
        return "Recovery action became stale because the source issue now has a pending issue interaction.";
      }

      const approvals = await issueApprovalsSvc.listApprovalsForIssue(issue.id);
      if (approvals.some((approval) => approval.status === "pending" || approval.status === "revision_requested")) {
        return "Recovery action became stale because the source issue now has a pending approval.";
      }
    }

    const monitor = summarizeIssueMonitor(issue, normalizeIssueExecutionPolicy(issue.executionPolicy ?? null));
    if (monitor.nextCheckAt && Date.parse(monitor.nextCheckAt) > Date.now()) {
      return "Recovery action became stale because the source issue now has a scheduled monitor.";
    }

    return null;
  }

  async function revalidateActiveSourceRecovery(input: {
    issue: IssueRouteSnapshot;
    trigger: RecoveryRevalidationTrigger;
    actor?: ReturnType<typeof getActorInfo> | null;
    activeRecoveryAction?: Awaited<ReturnType<typeof recoveryActionsSvc.getActiveForIssue>> | null;
    statusChanged?: boolean;
    assigneeChanged?: boolean;
    blockersChanged?: boolean;
    executionPolicyChanged?: boolean;
    monitorChanged?: boolean;
    documentChanged?: boolean;
    workProductChanged?: boolean;
    resumeRequested?: boolean;
    reopened?: boolean;
    blockedToTodoRecovery?: boolean;
  }) {
    const activeRecoveryAction =
      input.activeRecoveryAction === undefined
        ? await recoveryActionsSvc.getActiveForIssue(input.issue.companyId, input.issue.id)
        : input.activeRecoveryAction;
    if (!activeRecoveryAction) return null;

    const resolutionNote = await classifySourceRecoveryRevalidation(input);
    if (!resolutionNote) return activeRecoveryAction;

    const resolved = await recoveryActionsSvc.resolveActiveForIssue({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      actionId: activeRecoveryAction.id,
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote,
    });
    if (!resolved) return activeRecoveryAction;

    const actor = input.actor;
    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: actor?.actorType ?? "system",
      actorId: actor?.actorId ?? "system",
      agentId: actor?.agentId ?? null,
      runId: actor?.runId ?? null,
      action: "issue.recovery_action_resolved",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        recoveryActionId: resolved.id,
        recoveryActionStatus: resolved.status,
        outcome: resolved.outcome,
        sourceIssueStatus: input.issue.status,
        resolutionNote: resolved.resolutionNote,
        source: "source_revalidation",
        trigger: input.trigger,
      },
    });

    return null;
  }

  async function revalidateActiveSourceRecoveryForRead(input: Parameters<typeof revalidateActiveSourceRecovery>[0]) {
    try {
      return await revalidateActiveSourceRecovery(input);
    } catch (err) {
      logger.warn(
        { err, issueId: input.issue.id, trigger: input.trigger },
        "failed to revalidate recovery action during read projection",
      );
      return input.activeRecoveryAction ?? null;
    }
  }

  async function revalidateActiveSourceRecoveryAfterCommittedWrite(
    input: Parameters<typeof revalidateActiveSourceRecovery>[0],
  ) {
    try {
      return await revalidateActiveSourceRecovery(input);
    } catch (err) {
      logger.warn(
        { err, issueId: input.issue.id, trigger: input.trigger },
        "failed to revalidate recovery action after committed issue write",
      );
      return input.activeRecoveryAction ?? null;
    }
  }

  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  async function assertIssueEnvironmentSelection(
    companyId: string,
    environmentId: string | null | undefined,
  ) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(
      environmentsSvc,
      companyId,
      environmentId,
      { allowedDrivers: ["local", "ssh", "sandbox"] },
    );
  }

  async function assertAgentInReviewReviewPath(input: {
    existing: {
      id: string;
      companyId: string;
      status: string;
      assigneeUserId?: string | null;
      executionState?: unknown;
      monitorNextCheckAt?: Date | null;
    };
    updateFields: Record<string, unknown>;
    actorType: string;
  }) {
    const nextStatus = typeof input.updateFields.status === "string"
      ? input.updateFields.status
      : input.existing.status;
    if (input.actorType !== "agent" || input.existing.status === "in_review" || nextStatus !== "in_review") return;

    const nextAssigneeUserId = input.updateFields.assigneeUserId === undefined
      ? input.existing.assigneeUserId
      : input.updateFields.assigneeUserId;
    if (typeof nextAssigneeUserId === "string" && nextAssigneeUserId.trim().length > 0) return;

    const nextExecutionState = input.updateFields.executionState === undefined
      ? input.existing.executionState
      : input.updateFields.executionState;
    if (hasExecutionParticipant(nextExecutionState)) return;

    const nextExecutionPolicy = input.updateFields.executionPolicy;
    if (hasScheduledMonitor({
      existingMonitorNextCheckAt: input.existing.monitorNextCheckAt ?? null,
      patchMonitorNextCheckAt: input.updateFields.monitorNextCheckAt,
      executionPolicy: nextExecutionPolicy,
    })) return;

    const interactions = await issueThreadInteractionService(db).listForIssue(input.existing.id);
    if (interactions.some((interaction) => interaction.status === "pending")) return;

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(input.existing.id);
    if (approvals.some((approval) => ACTIVE_REVIEW_APPROVAL_STATUSES.has(String(approval.status)))) return;

    throw unprocessable(INVALID_AGENT_IN_REVIEW_DISPOSITION_MESSAGE, {
      code: "invalid_issue_disposition",
      missing: "review_path",
      validReviewPaths: [
        "pending_issue_thread_interaction",
        "linked_pending_approval",
        "human_assignee_user_id",
        "typed_execution_state_current_participant",
        "scheduled_issue_monitor",
      ],
    });
  }

  async function logExpiredRequestConfirmations(input: {
    issue: { id: string; companyId: string; identifier?: string | null };
    interactions: Array<{ id: string; kind: string; status: string; result?: unknown }>;
    actor: ReturnType<typeof getActorInfo>;
    source: string;
  }) {
    for (const interaction of input.interactions) {
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.thread_interaction_expired",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          identifier: input.issue.identifier ?? null,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          source: input.source,
          result: interaction.result ?? null,
        },
      });
    }
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Invalid ${field} query value`);
    }
    return parsed;
  }

  async function runSingleFileUpload(req: Request, res: Response, fileSizeLimit: number) {
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: fileSizeLimit, files: 1 },
    });
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageIssueApprovalLinks(req: Request, res: Response, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return true;
    if (!req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    if (actorAgent.role === "orchestrator" || Boolean(actorAgent.permissions?.canCreateAgents)) return true;
    res.status(403).json({ error: "Missing permission to link approvals" });
    return false;
  }

  function actorCanAccessCompany(req: Request, companyId: string) {
    if (req.actor.type === "none") return false;
    if (req.actor.type === "agent") return req.actor.companyId === companyId;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return (req.actor.companyIds ?? []).includes(companyId);
  }

  type TaskAssignmentAuthorizationScope = {
    issueId?: string | null;
    projectId?: string | null;
    parentIssueId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
  };

  async function resolveAssignmentProjectId(input: {
    companyId: string;
    projectId: string | null | undefined;
    parentIssueId?: string | null;
  }) {
    if (input.projectId !== undefined) return input.projectId;
    if (!input.parentIssueId) return null;
    const parent = await svc.getById(input.parentIssueId);
    if (!parent || parent.companyId !== input.companyId) return null;
    return parent.projectId ?? null;
  }

  async function assertCanAssignTasks(
    req: Request,
    companyId: string,
    assignmentScope?: TaskAssignmentAuthorizationScope,
  ) {
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId,
        issueId: assignmentScope?.issueId ?? null,
        projectId: assignmentScope?.projectId ?? null,
        parentIssueId: assignmentScope?.parentIssueId ?? null,
        assigneeAgentId: assignmentScope?.assigneeAgentId ?? null,
        assigneeUserId: assignmentScope?.assigneeUserId ?? null,
      },
      scope: assignmentScope ?? null,
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation);
  }

  function requireAgentRunId(req: Request, res: Response) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (runId) return runId;
    res.status(401).json({ error: "Agent run id required" });
    return null;
  }

  async function hasActiveCheckoutManagementOverride(
    actorAgentId: string,
    companyId: string,
    assigneeAgentId: string,
  ) {
    const decision = await access.decide({
      actor: { type: "agent", agentId: actorAgentId, companyId },
      action: "tasks:manage_active_checkouts",
      resource: { type: "issue", companyId, assigneeAgentId },
    });
    return decision.allowed;
  }

  async function assertAgentIssueMutationAllowed(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (issue.assigneeAgentId === null) {
      return true;
    }
    if (issue.assigneeAgentId !== actorAgentId) {
      if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)) {
        return true;
      }
      if (issue.status === "in_progress") {
        res.status(409).json({
          error: "Issue is checked out by another agent",
          details: {
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            actorAgentId,
          },
        });
      } else {
        res.status(403).json({
          error: "Agent cannot mutate another agent's issue",
          details: {
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            actorAgentId,
            status: issue.status,
            securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
          },
        });
      }
      return false;
    }
    if (issue.status !== "in_progress") {
      return true;
    }
    const runId = requireAgentRunId(req, res);
    if (!runId) return false;
    const ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.checkout_lock_adopted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      });
    }
    return true;
  }

  function isStatusOnlyCheapRecoveryContext(contextSnapshot: unknown) {
    if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
    const context = contextSnapshot as Record<string, unknown>;
    return context.modelProfile === "cheap" &&
      context.recoveryIntent === "status_only" &&
      context.allowDeliverableWork === false &&
      context.allowDocumentUpdates === false &&
      context.resumeRequiresNormalModel === true;
  }

  function requestsCheapIssueAssigneeModelProfile(input: { assigneeAdapterOverrides?: unknown }) {
    const overrides = input.assigneeAdapterOverrides;
    return !!overrides &&
      typeof overrides === "object" &&
      !Array.isArray(overrides) &&
      (overrides as Record<string, unknown>).modelProfile === "cheap";
  }

  async function loadActorRunContext(req: Request, companyId: string) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (!runId) return null;
    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return null;
    return run;
  }

  async function assertCheapRecoveryIssueAssigneeProfileAllowed(
    req: Request,
    res: Response,
    issue: { id?: string; companyId: string },
    input: { assigneeAdapterOverrides?: unknown },
  ) {
    if (!requestsCheapIssueAssigneeModelProfile(input)) return true;
    const run = await loadActorRunContext(req, issue.companyId);
    if (!run || !isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Cheap status-only recovery runs cannot assign downstream issue work to the cheap model profile",
      details: {
        issueId: issue.id ?? null,
        runId: run.id,
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
      },
    });
    return false;
  }

  async function assertDeliverableMutationAllowedByRunContext(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string },
  ) {
    const run = await loadActorRunContext(req, issue.companyId);
    if (!run) return true;
    if (!isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Cheap status-only recovery runs cannot update issue documents, plans, or deliverable artifacts",
      details: {
        issueId: issue.id,
        runId: run.id,
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
      },
    });
    return false;
  }

  function assertStructuredCommentFieldsAllowed(
    req: Request,
    res: Response,
    input: { presentation?: unknown; metadata?: unknown },
  ) {
    const hasStructuredFields = input.presentation !== undefined || input.metadata !== undefined;
    if (!hasStructuredFields) return true;
    if (req.actor.type === "board") return true;
    res.status(403).json({
      error: "Only board users may set structured comment presentation or metadata",
      details: {
        securityPrinciples: ["Least Privilege", "Secure Defaults", "Complete Mediation"],
      },
    });
    return false;
  }

  async function assertExplicitResumeIntentAllowed(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (issue.status === "cancelled") {
      res.status(409).json({
        error: "Cancelled issues must be restored through the dedicated restore flow",
        details: {
          issueId: issue.id,
          status: issue.status,
        },
      });
      return false;
    }

    if (!isExplicitResumeCapableStatus(issue.status)) {
      res.status(409).json({
        error: "Issue is not resumable through comment follow-up intent",
        details: { issueId: issue.id, status: issue.status },
      });
      return false;
    }

    const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issue.companyId, issue.id);
    if (activePauseHold) {
      res.status(409).json({
        error: "Issue follow-up blocked by active subtree pause hold",
        details: {
          issueId: issue.id,
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
        },
      });
      return false;
    }

    if (issue.status === "blocked") {
      const readiness = await svc.getDependencyReadiness(issue.id);
      if (readiness.unresolvedBlockerCount > 0) {
        res.status(409).json({
          error: "Issue follow-up blocked by unresolved blockers",
          details: {
            issueId: issue.id,
            unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
          },
        });
        return false;
      }
    }

    if (req.actor.type !== "agent") return true;

    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (!issue.assigneeAgentId) {
      res.status(409).json({
        error: "Issue follow-up requires an assigned agent",
        details: { issueId: issue.id, actorAgentId },
      });
      return false;
    }
    if (issue.assigneeAgentId === actorAgentId) return true;
    if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)) {
      return true;
    }

    res.status(403).json({
      error: "Agent cannot request follow-up for another agent's issue",
      details: {
        issueId: issue.id,
        assigneeAgentId: issue.assigneeAgentId,
        actorAgentId,
      },
    });
    return false;
  }

  async function assertRecoveryActionAuthority(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; assigneeAgentId: string | null },
    activeRecoveryAction: Awaited<ReturnType<typeof recoveryActionsSvc.getActiveForIssue>>,
    input: { source: "issue_update" | "recovery_action_resolution" },
  ) {
    if (req.actor.type !== "agent") return true;
    if (!activeRecoveryAction) return true;

    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (issue.assigneeAgentId === actorAgentId) return true;
    if (
      issue.assigneeAgentId &&
      await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)
    ) {
      return true;
    }
    if (activeRecoveryAction.ownerAgentId === actorAgentId) return true;
    if (
      activeRecoveryAction.ownerAgentId &&
      await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, activeRecoveryAction.ownerAgentId)
    ) {
      return true;
    }

    res.status(403).json({
      error: "Agent cannot resolve another owner's recovery action",
      details: {
        issueId: issue.id,
        recoveryActionId: activeRecoveryAction.id,
        actorAgentId,
        assigneeAgentId: issue.assigneeAgentId,
        recoveryOwnerAgentId: activeRecoveryAction.ownerAgentId,
        source: input.source,
        securityPrinciples: ["Least Privilege", "Complete Mediation", "Secure Defaults"],
      },
    });
    return false;
  }

  async function resolveActiveIssueRun(issue: {
    id: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  }) {
    let runToInterrupt = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;

    if ((!runToInterrupt || runToInterrupt.status !== "running") && issue.assigneeAgentId) {
      const activeRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const activeIssueId =
        activeRun &&
        activeRun.contextSnapshot &&
        typeof activeRun.contextSnapshot === "object" &&
        typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
          ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
          : null;
      if (activeRun && activeRun.status === "running" && activeIssueId === issue.id) {
        runToInterrupt = activeRun;
      }
    }

    return runToInterrupt?.status === "running" ? runToInterrupt : null;
  }

  async function normalizeIssueAssigneeAgentReference(
    companyId: string,
    rawAssigneeAgentId: string | null | undefined,
  ) {
    if (rawAssigneeAgentId === undefined || rawAssigneeAgentId === null) {
      return rawAssigneeAgentId;
    }

    const raw = rawAssigneeAgentId.trim();
    if (raw.length === 0) {
      return rawAssigneeAgentId;
    }

    const resolved = await agentsSvc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    return resolved.agent.id;
  }
  function toValidTimestamp(value: Date | string | null | undefined) {
    if (!value) return null;
    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function isQueuedIssueCommentForActiveRun(params: {
    comment: {
      authorAgentId?: string | null;
      createdAt?: Date | string | null;
    };
    activeRun: {
      agentId?: string | null;
      startedAt?: Date | string | null;
      createdAt?: Date | string | null;
    };
  }) {
    const activeRunStartedAtMs =
      toValidTimestamp(params.activeRun.startedAt) ?? toValidTimestamp(params.activeRun.createdAt);
    const commentCreatedAtMs = toValidTimestamp(params.comment.createdAt);

    if (activeRunStartedAtMs === null || commentCreatedAtMs === null) return false;
    if (params.comment.authorAgentId && params.comment.authorAgentId === params.activeRun.agentId) return false;
    return commentCreatedAtMs >= activeRunStartedAtMs;
  }
  async function getClosedIssueExecutionWorkspace(issue: { executionWorkspaceId?: string | null }) {
    if (!issue.executionWorkspaceId) return null;
    const workspace = await executionWorkspacesSvc.getById(issue.executionWorkspaceId);
    if (!workspace || !isClosedIsolatedExecutionWorkspace(workspace)) return null;
    return workspace;
  }

  // WC-DSR (designer visual self-review): resolve the issue's realized execution
  // workspace cwd (where the rendered 시안 PNG is written so it sits beside the
  // work). Null when the issue has no realized workspace yet — the caller then
  // falls back to a server-managed preview dir (see resolveSianPreviewPngPath).
  async function resolveIssueWorkspaceCwd(issue: {
    executionWorkspaceId?: string | null;
  }): Promise<string | null> {
    if (!issue.executionWorkspaceId) return null;
    const workspace = await executionWorkspacesSvc.getById(issue.executionWorkspaceId);
    return workspace?.cwd ?? null;
  }

  // Bind resolveSianHtml to this router's storage + asset service. Resolves a
  // 시안 url to HTML across BOTH the legacy inline data: form and the new short
  // asset url (/api/assets/<id>/content). expectedCompanyId scopes the asset
  // read to the issue's company (defense-in-depth on top of the route auth gate).
  const resolveSianHtmlForCompany = (
    url: string | null | undefined,
    expectedCompanyId?: string | null,
  ): Promise<string | null> =>
    resolveSianHtml(
      {
        getAsset: async (id) => {
          const a = await serviceIndex.assetService(db).getById(id);
          return a ? { companyId: a.companyId, objectKey: a.objectKey, contentType: a.contentType } : null;
        },
        getObject: (companyId, objectKey) => storage.getObject(companyId, objectKey),
      },
      url,
      expectedCompanyId,
    );

  // WC-DSR: render a 시안 work product to a PNG and write it to a stable absolute
  // path. Returns { pngPath, html } on success; throws EmptySianHtmlError when
  // the 시안 is empty (caller maps to 422) and rethrows render/browser errors.
  // Resolves the 시안 HTML from a data: url OR a short asset url; a non-resolvable
  // url (live link / image data url) cannot be rendered here and yields null so
  // the caller can skip.
  async function renderAndStoreSianPreview(input: {
    issueId: string;
    companyId: string;
    workProduct: { id: string; url: string | null };
    workspaceCwd: string | null;
    html?: string | null;
  }): Promise<{ pngPath: string } | null> {
    const html =
      (typeof input.html === "string" && input.html.length > 0
        ? input.html
        : await resolveSianHtmlForCompany(input.workProduct.url, input.companyId)) ?? null;
    if (html === null) return null;
    const pngBuffer = await renderSianToPng(html);
    const pngPath = resolveSianPreviewPngPath({
      workspaceCwd: input.workspaceCwd,
      issueId: input.issueId,
      workProductId: input.workProduct.id,
    });
    await fs.mkdir(path.dirname(pngPath), { recursive: true });
    await fs.writeFile(pngPath, pngBuffer);
    return { pngPath };
  }

  // WC-DSR: after a designer attaches/updates a 시안 that is not yet
  // board-approved, render it and re-wake the DESIGNER with the rendered PNG as
  // image input so it SEES its own design and reviews it before submitting.
  // Idempotent + best-effort: a render failure or a missing designer never
  // blocks the attach (the design is already stored); we log and move on. The
  // round cap (SIAN_SELF_REVIEW_ROUND_CAP) is enforced by the caller, which
  // increments the counter on the work product metadata.
  async function enqueueDesignSelfReviewWake(input: {
    issue: { id: string; companyId: string };
    designerAgentId: string;
    workProductId: string;
    pngPath: string;
    round: number;
  }) {
    await heartbeat.wakeup(input.designerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId: input.issue.id,
        designSelfReviewFor: input.workProductId,
        mutation: "design_self_review",
      },
      requestedByActorType: "system",
      contextSnapshot: {
        issueId: input.issue.id,
        taskId: input.issue.id,
        wakeReason: "issue_commented",
        source: "design.self_review",
        // The adapters attach these absolute PNG paths as image input on the
        // designer's next run (codex --image / claude Read), so the agent sees
        // the rendered screenshot of its own 시안.
        designReviewImagePaths: [input.pngPath],
        designSelfReviewFor: input.workProductId,
        designSelfReviewRound: input.round,
        designSelfReviewRoundCap: SIAN_SELF_REVIEW_ROUND_CAP,
      },
    });
  }

  function respondClosedIssueExecutionWorkspace(
    res: Response,
    workspace: Pick<ExecutionWorkspace, "closedAt" | "id" | "mode" | "name" | "status">,
  ) {
    res.status(409).json({
      error: getClosedIsolatedExecutionWorkspaceMessage(workspace),
      executionWorkspace: workspace,
    });
  }

  async function resolveIssueRouteId(rawId: string): Promise<string> {
    const identifier = normalizeIssueReferenceIdentifier(rawId);
    if (identifier) {
      const issue = await svc.getByIdentifier(identifier);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
  }

  async function resolveIssueProjectAndGoal(issue: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = issue.projectId ? projectsSvc.getById(issue.projectId) : Promise.resolve(null);
    const directGoalPromise = issue.goalId ? goalsSvc.getById(issue.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    const projectGoalId = project?.goalId ?? project?.goalIds[0] ?? null;
    if (projectGoalId) {
      const projectGoal = await goalsSvc.getById(projectGoalId);
      return { project, goal: projectGoal };
    }

    if (!issue.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(issue.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await resolveIssueRouteId(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await resolveIssueRouteId(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/companies/:companyId/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = companySearchQuerySchema.parse(req.query);
    const rateLimit = searchRateLimiter.consume(companySearchRateLimitActor(req, companyId));
    res.setHeader("X-RateLimit-Limit", String(rateLimit.limit));
    res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      res.status(429).json({
        error: "Search rate limit exceeded",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }
    const result = await getSearchService().search(companyId, query);
    res.json(result);
  });

  router.get("/companies/:companyId/issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const assigneeUserFilterRaw = req.query.assigneeUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const inboxArchivedByUserFilterRaw = req.query.inboxArchivedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : assigneeUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : touchedByUserFilterRaw;
    const inboxArchivedByUserId =
      inboxArchivedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : inboxArchivedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : unreadForUserFilterRaw;
    const rawLimit = req.query.limit as string | undefined;
    const parsedLimit = rawLimit !== undefined && /^\d+$/.test(rawLimit)
      ? Number.parseInt(rawLimit, 10)
      : null;
    const limit = parsedLimit === null ? ISSUE_LIST_DEFAULT_LIMIT : clampIssueListLimit(parsedLimit);
    const rawOffset = req.query.offset as string | undefined;
    const parsedOffset = rawOffset !== undefined && /^\d+$/.test(rawOffset)
      ? Number.parseInt(rawOffset, 10)
      : null;
    const attention = req.query.attention as string | undefined;
    const sortField = req.query.sortField as string | undefined;
    const sortDir = req.query.sortDir as string | undefined;

    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (inboxArchivedByUserFilterRaw === "me" && (!inboxArchivedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "inboxArchivedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }
    if (attention !== undefined && attention !== "blocked") {
      res.status(400).json({ error: "attention must be 'blocked' when provided" });
      return;
    }
    if (rawLimit !== undefined && (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      res.status(400).json({ error: `limit must be a positive integer up to ${ISSUE_LIST_MAX_LIMIT}` });
      return;
    }
    if (rawOffset !== undefined && (parsedOffset === null || !Number.isInteger(parsedOffset) || parsedOffset < 0)) {
      res.status(400).json({ error: "offset must be a non-negative integer" });
      return;
    }
    if (sortField !== undefined && sortField !== "updated") {
      res.status(400).json({ error: "sortField must be 'updated' when provided" });
      return;
    }
    if (sortDir !== undefined && sortDir !== "asc" && sortDir !== "desc") {
      res.status(400).json({ error: "sortDir must be 'asc' or 'desc' when provided" });
      return;
    }
    const offset = parsedOffset ?? 0;

    const result = await svc.list(companyId, {
      attention: attention === "blocked" ? "blocked" : undefined,
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId: req.query.projectId as string | undefined,
      workspaceId: req.query.workspaceId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      descendantOf: req.query.descendantOf as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originKindPrefix: req.query.originKindPrefix as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      excludeRoutineExecutions:
        req.query.excludeRoutineExecutions === "true" || req.query.excludeRoutineExecutions === "1",
      includePluginOperations:
        req.query.includePluginOperations === "true" || req.query.includePluginOperations === "1",
      includeBlockedBy: req.query.includeBlockedBy === "true" || req.query.includeBlockedBy === "1",
      includeBlockedInboxAttention:
        req.query.includeBlockedInboxAttention === "true" || req.query.includeBlockedInboxAttention === "1",
      q: req.query.q as string | undefined,
      limit,
      offset,
      sortField: sortField === "updated" ? "updated" : undefined,
      sortDir: sortDir === "asc" || sortDir === "desc" ? sortDir : undefined,
    });
    const issueIds = result.map((issue) => issue.id);
    const [handoffStates, recoveryActionByIssue] = await Promise.all([
      listSuccessfulRunHandoffStates(db, companyId, issueIds),
      recoveryActionsSvc.listActiveForIssues(companyId, issueIds),
    ]);
    const actor = getActorInfo(req);
    await Promise.all(result.map(async (issue) => {
      const activeRecoveryAction = recoveryActionByIssue.get(issue.id) ?? null;
      if (!activeRecoveryAction) return;
      const revalidated = await revalidateActiveSourceRecoveryForRead({
        issue,
        trigger: "read_projection",
        actor,
        activeRecoveryAction,
      });
      if (revalidated) recoveryActionByIssue.set(issue.id, revalidated);
      else recoveryActionByIssue.delete(issue.id);
    }));
    res.json(result.map((issue) => ({
      ...issue,
      successfulRunHandoff: handoffStates.get(issue.id) ?? null,
      activeRecoveryAction: recoveryActionByIssue.get(issue.id) ?? null,
    })));
  });

  router.get("/companies/:companyId/issues/count", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const attention = req.query.attention as string | undefined;
    if (attention !== "blocked") {
      res.status(400).json({ error: "issues/count currently requires attention=blocked" });
      return;
    }
    if (req.query.limit !== undefined || req.query.offset !== undefined) {
      res.status(400).json({ error: "issues/count does not accept limit or offset" });
      return;
    }

    const count = await svc.count(companyId, {
      attention: "blocked",
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId: req.query.assigneeUserId as string | undefined,
      projectId: req.query.projectId as string | undefined,
      workspaceId: req.query.workspaceId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      descendantOf: req.query.descendantOf as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originKindPrefix: req.query.originKindPrefix as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      excludeRoutineExecutions:
        req.query.excludeRoutineExecutions === "true" || req.query.excludeRoutineExecutions === "1",
      includePluginOperations:
        req.query.includePluginOperations === "true" || req.query.includePluginOperations === "1",
      includeBlockedBy: true,
      includeBlockedInboxAttention: true,
      q: req.query.q as string | undefined,
    });
    res.json({ count });
  });

  router.get("/companies/:companyId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listLabels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/labels", validate(createIssueLabelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const label = await svc.createLabel(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/issues/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const wakeCommentId =
      typeof req.query.wakeCommentId === "string" && req.query.wakeCommentId.trim().length > 0
        ? req.query.wakeCommentId.trim()
        : null;

    const currentExecutionWorkspacePromise = issue.executionWorkspaceId
      ? executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : Promise.resolve(null);
    const designGatePromise =
      typeof workProductsSvc.deriveDesignGateForIssue === "function"
        ? workProductsSvc.deriveDesignGateForIssue(issue.id, issue.companyId)
        : workProductsSvc.listForIssue(issue.id).then((workProducts) => deriveIssueDesignGate(workProducts));

    const [
      { project, goal },
      ancestors,
      commentCursor,
      wakeComment,
      relations,
      blockerAttention,
      productivityReview,
      scheduledRetry,
      attachments,
      continuationSummary,
      currentExecutionWorkspace,
      activeRecoveryAction,
      designGate,
    ] =
      await Promise.all([
        resolveIssueProjectAndGoal(issue),
        svc.getAncestors(issue.id),
        svc.getCommentCursor(issue.id),
        wakeCommentId ? svc.getComment(wakeCommentId) : null,
        svc.getRelationSummaries(issue.id),
        svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
        svc.listProductivityReviews(issue.companyId, [issue.id]).then((map) => map.get(issue.id) ?? null),
        svc.getCurrentScheduledRetry(issue.id),
        svc.listAttachments(issue.id),
        documentsSvc.getIssueDocumentByKey(issue.id, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY),
        currentExecutionWorkspacePromise,
        recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id),
        designGatePromise,
      ]);
    const recoveryActionsByRelationIssue = await relationRecoveryActionMap(
      recoveryActionsSvc,
      issue.companyId,
      relations,
    );
    const relationsWithRecoveryActions = withRecoveryActionsOnRelationSummaries(
      relations,
      recoveryActionsByRelationIssue,
    );
    const revalidatedActiveRecoveryAction = await revalidateActiveSourceRecoveryForRead({
      issue,
      trigger: "read_projection",
      actor: getActorInfo(req),
      activeRecoveryAction,
    });

    res.json({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        workMode: issue.workMode,
        ...(blockerAttention ? { blockerAttention } : {}),
        productivityReview,
        scheduledRetry,
        activeRecoveryAction: revalidatedActiveRecoveryAction,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: goal?.id ?? issue.goalId,
        parentId: issue.parentId,
        blockedBy: relationsWithRecoveryActions.blockedBy,
        blocks: relationsWithRecoveryActions.blocks,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        originKind: issue.originKind,
        originId: issue.originId,
        updatedAt: issue.updatedAt,
      },
      ancestors: ancestors.map((ancestor) => ({
        id: ancestor.id,
        identifier: ancestor.identifier,
        title: ancestor.title,
        status: ancestor.status,
        priority: ancestor.priority,
      })),
      project: project
        ? {
            id: project.id,
            name: project.name,
            status: project.status,
            targetDate: project.targetDate,
          }
        : null,
      goal: goal
        ? {
            id: goal.id,
            title: goal.title,
            status: goal.status,
            level: goal.level,
            parentId: goal.parentId,
          }
        : null,
      commentCursor,
      wakeComment:
        wakeComment && wakeComment.issueId === issue.id
          ? wakeComment
          : null,
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.originalFilename,
        contentType: a.contentType,
        byteSize: a.byteSize,
        contentPath: withContentPath(a).contentPath,
        createdAt: a.createdAt,
      })),
      continuationSummary: continuationSummary
        ? {
            key: continuationSummary.key,
            title: continuationSummary.title,
            body: continuationSummary.body,
            latestRevisionId: continuationSummary.latestRevisionId,
            latestRevisionNumber: continuationSummary.latestRevisionNumber,
            updatedAt: continuationSummary.updatedAt,
          }
        : null,
      currentExecutionWorkspace,
      // WC-182f / D22: the same design gate projection used by execution wakes.
      // When approved → build against the source-of-truth design; when a
      // source-of-truth design exists but isn't approved → developmentHold +
      // a HOLD directive. Additive only — does not touch the run machinery.
      designGate,
    });
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const [
      { project, goal },
      ancestors,
      mentionedProjectIds,
      documentPayload,
      relations,
      blockerAttention,
      productivityReview,
      referenceSummary,
      successfulRunHandoffStates,
      scheduledRetry,
      activeRecoveryAction,
    ] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id, { includeCommentBodies: false }),
      documentsSvc.getIssueDocumentPayload(issue),
      svc.getRelationSummaries(issue.id),
      svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
      svc.listProductivityReviews(issue.companyId, [issue.id]).then((map) => map.get(issue.id) ?? null),
      issueReferencesSvc.listIssueReferenceSummary(issue.id),
      listSuccessfulRunHandoffStates(db, issue.companyId, [issue.id]),
      svc.getCurrentScheduledRetry(issue.id),
      recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id),
    ]);
    const recoveryActionsByRelationIssue = await relationRecoveryActionMap(
      recoveryActionsSvc,
      issue.companyId,
      relations,
    );
    const relationsWithRecoveryActions = withRecoveryActionsOnRelationSummaries(
      relations,
      recoveryActionsByRelationIssue,
    );
    const revalidatedActiveRecoveryAction = await revalidateActiveSourceRecoveryForRead({
      issue,
      trigger: "read_projection",
      actor: getActorInfo(req),
      activeRecoveryAction,
    });
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json({
      ...issue,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      ...(blockerAttention ? { blockerAttention } : {}),
      productivityReview,
      successfulRunHandoff: successfulRunHandoffStates.get(issue.id) ?? null,
      scheduledRetry,
      activeRecoveryAction: revalidatedActiveRecoveryAction,
      blockedBy: relationsWithRecoveryActions.blockedBy,
      blocks: relationsWithRecoveryActions.blocks,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
      ...documentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace,
      workProducts,
    });
  });

  router.get("/issues/:id/recovery-actions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const active = await revalidateActiveSourceRecoveryForRead({
      issue,
      trigger: "read_projection",
      actor: getActorInfo(req),
    });
    res.json({
      active,
      actions: active ? [active] : [],
    });
  });

  router.post("/issues/:id/recovery-actions/resolve", validate(resolveIssueRecoveryActionSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    const activeRecoveryAction = await recoveryActionsSvc.getActiveForIssue(existing.companyId, existing.id);
    if (
      !(await assertRecoveryActionAuthority(
        req,
        res,
        existing,
        activeRecoveryAction,
        { source: "recovery_action_resolution" },
      ))
    ) {
      return;
    }

    const { actionId, outcome, sourceIssueStatus, resolutionNote } = req.body;
    if (outcome === "false_positive" || outcome === "cancelled") {
      assertBoard(req);
    }

    const actor = getActorInfo(req);
    const updateFields = sourceIssueStatus ? { status: sourceIssueStatus } : {};
    await assertAgentInReviewReviewPath({
      existing,
      updateFields,
      actorType: req.actor.type,
    });

    const actionStatus = outcome === "cancelled" ? "cancelled" : "resolved";
    const result = await db.transaction(async (tx) => {
      let issue = existing;
      if (outcome === "blocked") {
        const unresolvedBlockers = await tx
          .select({ id: issueRows.id })
          .from(issueRelations)
          .innerJoin(issueRows, eq(issueRelations.issueId, issueRows.id))
          .where(
            and(
              eq(issueRelations.companyId, existing.companyId),
              eq(issueRelations.relatedIssueId, existing.id),
              eq(issueRelations.type, "blocks"),
              notInArray(issueRows.status, ["done", "cancelled"]),
            ),
          )
          .limit(1);
        if (unresolvedBlockers.length === 0) {
          throw unprocessable("Blocked recovery resolution requires an unresolved first-class blocker on the source issue");
        }
      }

      if (sourceIssueStatus) {
        const updatedIssue = await svc.update(
          id,
          {
            status: sourceIssueStatus,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
            // Recovery resolution is an authorized governance disposition (the
            // recovery owner is asserting the outcome), not normal work completion —
            // it must not be blocked by the proof-of-work gate.
            bypassProofRequirement: true,
          },
          tx,
        );
        if (!updatedIssue) throw notFound("Issue not found");
        issue = updatedIssue;
      }

      const recoveryAction = await recoveryActionsSvc.resolveActiveForIssue(
        {
          companyId: existing.companyId,
          sourceIssueId: existing.id,
          actionId: actionId ?? null,
          status: actionStatus,
          outcome,
          resolutionNote: resolutionNote ?? null,
        },
        tx,
      );
      if (!recoveryAction) throw notFound("Active recovery action not found");

      return { issue, recoveryAction };
    });

    await routinesSvc.syncRunStatusForIssue(result.issue.id);

    if (sourceIssueStatus && existing.status !== result.issue.status) {
      await logActivity(db, {
        companyId: result.issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: result.issue.id,
        details: {
          identifier: result.issue.identifier,
          status: result.issue.status,
          source: "recovery_action_resolution",
          recoveryActionId: result.recoveryAction.id,
          _previous: {
            status: existing.status,
          },
        },
      });
    }

    await logActivity(db, {
      companyId: result.issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.recovery_action_resolved",
      entityType: "issue",
      entityId: result.issue.id,
      details: {
        identifier: result.issue.identifier,
        recoveryActionId: result.recoveryAction.id,
        recoveryActionStatus: result.recoveryAction.status,
        outcome: result.recoveryAction.outcome,
        sourceIssueStatus: sourceIssueStatus ?? null,
        resolutionNote: result.recoveryAction.resolutionNote,
      },
    });

    if (
      sourceIssueStatus === "todo" &&
      existing.status !== result.issue.status &&
      result.issue.assigneeAgentId
    ) {
      void heartbeat.wakeup(result.issue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_recovery_action_restored",
        payload: {
          issueId: result.issue.id,
          recoveryActionId: result.recoveryAction.id,
          mutation: "recovery_action_resolution",
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: result.issue.id,
          taskId: result.issue.id,
          wakeReason: "issue_recovery_action_restored",
          source: "issue.recovery_action_resolution",
          recoveryActionId: result.recoveryAction.id,
        },
      }).catch((err) =>
        logger.warn(
          { err, issueId: result.issue.id, agentId: result.issue.assigneeAgentId },
          "failed to wake agent after recovery action restored issue",
        ));
    }

    res.json({
      issue: {
        ...result.issue,
        activeRecoveryAction: null,
      },
      recoveryAction: result.recoveryAction,
    });
  });

  router.get("/issues/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json(workProducts);
  });

  router.get("/issues/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const docs = await documentsSvc.listIssueDocuments(issue.id, {
      includeSystem: req.query.includeSystem === "true",
    });
    res.json(docs);
  });

  router.get("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  });

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const documentMojibake = buildMojibakeRejection({
      title: req.body.title,
      body: req.body.body,
    });
    if (documentMojibake) {
      res.status(400).json(documentMojibake);
      return;
    }

    const actor = getActorInfo(req);
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
      lockedDocumentStrategy: req.actor.type === "agent" ? "create_new_document" : "conflict",
    });
    const doc = result.document;
    const redirectedFromLockedDocument =
      "redirectedFromLockedDocument" in result ? result.redirectedFromLockedDocument : null;
    await issueReferencesSvc.syncDocument(doc.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
        redirectedFromLockedDocument,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    if (!result.created) {
      const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
        issue,
        {
          id: doc.id,
          key: doc.key,
          latestRevisionId: doc.latestRevisionId,
          latestRevisionNumber: doc.latestRevisionNumber,
        },
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        issue,
        interactions: expiredInteractions,
        actor,
        source: "issue.document_updated",
      });
    }

    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "document",
      actor,
      documentChanged: true,
    });

    res.status(result.created ? 201 : 200).json(doc);
  });

  router.post("/issues/:id/documents/:key/lock", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const result = await documentsSvc.lockIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      lockedByAgentId: actor.agentId ?? null,
      lockedByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    if (result.changed) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.document_locked",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          lockedAt: result.document.lockedAt,
        },
      });
    }

    res.json(result.document);
  });

  router.post("/issues/:id/documents/:key/unlock", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const result = await documentsSvc.unlockIssueDocument(issue.id, keyParsed.data);

    if (result.changed) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.document_unlocked",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
        },
      });
    }

    res.json(result.document);
  });

  router.get("/issues/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, keyParsed.data);
    res.json(revisions);
  });

  router.post(
    "/issues/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreIssueDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const revisionId = req.params.revisionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
      if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      const actor = getActorInfo(req);
      const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const result = await documentsSvc.restoreIssueDocumentRevision({
        issueId: issue.id,
        key: keyParsed.data,
        revisionId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await issueReferencesSvc.syncDocument(result.document.id);
      const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.document_restored",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          format: result.document.format,
          revisionNumber: result.document.latestRevisionNumber,
          restoredFromRevisionId: result.restoredFromRevisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
        issue,
        {
          id: result.document.id,
          key: result.document.key,
          latestRevisionId: result.document.latestRevisionId,
          latestRevisionNumber: result.document.latestRevisionNumber,
        },
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        issue,
        interactions: expiredInteractions,
        actor,
        source: "issue.document_restored",
      });

      await revalidateActiveSourceRecoveryAfterCommittedWrite({
        issue,
        trigger: "document",
        actor,
        documentChanged: true,
      });

      res.json(result.document);
    },
  );

  router.delete("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    await issueReferencesSvc.deleteDocumentSource(removed.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });
    const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
      issue,
      {
        id: removed.id,
        key: removed.key,
        latestRevisionId: null,
        latestRevisionNumber: null,
      },
      {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    );
    await logExpiredRequestConfirmations({
      issue,
      interactions: expiredInteractions,
      actor,
      source: "issue.document_deleted",
    });
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "document",
      actor,
      documentChanged: true,
    });
    res.json({ ok: true });
  });

  router.post("/issues/:id/work-products", validate(createIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, {
      ...req.body,
      projectId: req.body.projectId ?? issue.projectId ?? null,
    });
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "work_product",
      actor,
      workProductChanged: true,
    });
    res.status(201).json(product);
  });

  // WC-13 (D19 follow-up sweep): manual trigger that turns the parent issue's
  // compound-checklist `## 5. Follow-up issues` bullets into real backlog
  // issues. The route is intentionally separate from the document-PUT path —
  // auto-triggering on every checklist edit is too noisy (a user mid-typing
  // would spawn half-written titles). Calling this is idempotent: existing
  // child issues with originKind=compound_followup and the same title are
  // skipped. Returns `{ createdIssueIds: string[] }`.
  router.post("/issues/:id/compound-followups/process", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    const checklist = await documentsSvc.getIssueDocumentByKey(issue.id, "compound-checklist");
    if (!checklist) {
      res.status(404).json({ error: "Compound checklist not found for this issue" });
      return;
    }
    const actor = getActorInfo(req);
    const createdIssueIds = await compoundFollowupsSvc.processChecklist({
      parentIssueId: issue.id,
      companyId: issue.companyId,
      checklistBody: checklist.body ?? "",
      actorAgentId: actor.agentId,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.compound_followups_processed",
      entityType: "issue",
      entityId: issue.id,
      details: { createdIssueIds, createdCount: createdIssueIds.length },
    });
    res.status(200).json({ createdIssueIds });
  });

  // WC-19/WC-21 inner helper: try to spawn (or reuse) a planning child that
  // fills the parent's compound-checklist via the heartbeat/run path. Returns
  // null on no-checklist or no-planner (so the caller can choose to surface
  // an error or silently no-op). Idempotent against in-flight children
  // (returns reused=true rather than spawning a duplicate).
  async function tryAutofillCompoundChecklist(input: {
    parent: { id: string; companyId: string; identifier: string | null; title: string | null; projectId: string | null };
    actor: { actorType: "user" | "agent" | "system"; actorId: string | null; agentId: string | null; runId: string | null };
    contextSource: string;
  }): Promise<{ issue: any; reused: boolean } | null> {
    const { parent, actor, contextSource } = input;
    const checklist = await documentsSvc.getIssueDocumentByKey(parent.id, "compound-checklist");
    if (!checklist) return null;

    const plannerId = resolvePlannerCapableAgentId(await agentsSvc.list(parent.companyId));
    if (!plannerId) return null;

    // Idempotency: don't spawn duplicates if an unfinished autofill child
    // is already in flight. Treat done/cancelled/archived as "finished".
    const existing = await db
      .select({ id: issueRows.id, status: issueRows.status })
      .from(issueRows)
      .where(
        and(
          eq(issueRows.companyId, parent.companyId),
          eq(issueRows.parentId, parent.id),
          eq(issueRows.originKind, "compound_checklist_autofill"),
        ),
      );
    const activeChild = existing.find(
      (row) => row.status !== "done" && row.status !== "cancelled" && row.status !== "archived",
    );
    if (activeChild) {
      const full = await svc.getById(activeChild.id);
      return { issue: full, reused: true };
    }

    const instruction = buildCompoundFillInstruction({
      parentIssueId: parent.id,
      parentIdentifier: parent.identifier ?? parent.id,
      parentTitle: parent.title ?? "Untitled",
      existingChecklistBody: checklist.body ?? "",
    });

    const child = await svc.create(parent.companyId, {
      title: buildCompoundFillTitle(parent.identifier ?? parent.id, parent.title ?? "Untitled"),
      description: instruction,
      status: "todo",
      workMode: "planning",
      priority: "medium",
      assigneeAgentId: plannerId,
      projectId: parent.projectId ?? null,
      parentId: parent.id,
      originKind: "compound_checklist_autofill",
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: parent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId ?? "system",
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.compound_checklist_autofill_requested",
      entityType: "issue",
      entityId: parent.id,
      details: { childIssueId: child.id, plannerAgentId: plannerId, contextSource },
    });

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue: child,
      reason: "issue_assigned",
      mutation: "create",
      contextSource,
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    return { issue: child, reused: false };
  }

  // WC-22: status of the most-recent autofill child for this parent. Returns
  // `{ inFlight: null }` when there's no active autofill. Used by the UI to
  // render an "agent is reviewing" banner on the compound-checklist document.
  // Active = any compound_checklist_autofill child whose status isn't
  // done/cancelled/archived.
  router.get("/issues/:id/compound-checklist/autofill-status", async (req, res) => {
    const id = req.params.id as string;
    const parent = await svc.getById(id);
    if (!parent) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, parent.companyId);
    const rows = await db
      .select({
        id: issueRows.id,
        identifier: issueRows.identifier,
        title: issueRows.title,
        status: issueRows.status,
        assigneeAgentId: issueRows.assigneeAgentId,
        createdAt: issueRows.createdAt,
      })
      .from(issueRows)
      .where(
        and(
          eq(issueRows.companyId, parent.companyId),
          eq(issueRows.parentId, parent.id),
          eq(issueRows.originKind, "compound_checklist_autofill"),
        ),
      );
    const active = rows
      .filter((row) => row.status !== "done" && row.status !== "cancelled" && row.status !== "archived")
      .sort((a, b) =>
        (a.createdAt ?? new Date(0)).getTime() < (b.createdAt ?? new Date(0)).getTime() ? 1 : -1,
      )[0];
    res.json({ inFlight: active ?? null });
  });

  // WC-19 (D19 LLM auto-fill): user-initiated spawn of the autofill child.
  // Returns 404 if no checklist yet, 409 if no planner-capable agent exists
  // (i.e. the user *requested* it but the company isn't configured for it).
  router.post("/issues/:id/compound-checklist/auto-fill", async (req, res) => {
    const id = req.params.id as string;
    const parent = await svc.getById(id);
    if (!parent) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, parent.companyId);
    // WC-215: cap expensive LLM auto-fill runs per tenant.
    if (!enforceLlmRouteRateLimit(req, res, llmRateLimiter, parent.companyId)) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, parent))) return;
    const checklist = await documentsSvc.getIssueDocumentByKey(parent.id, "compound-checklist");
    if (!checklist) {
      res.status(404).json({ error: "Compound checklist not found for this issue" });
      return;
    }
    const plannerId = resolvePlannerCapableAgentId(await agentsSvc.list(parent.companyId));
    if (!plannerId) {
      res.status(409).json({
        error: "no planner-capable agent: assign an active agent with a planner, pm, or orchestrator role before requesting auto-fill.",
      });
      return;
    }

    const actor = getActorInfo(req);
    const result = await tryAutofillCompoundChecklist({
      parent,
      actor,
      contextSource: "issue.compound_checklist_autofill",
    });
    // The pre-checks above guarantee result is non-null here.
    if (!result) {
      res.status(500).json({ error: "Failed to spawn autofill" });
      return;
    }
    res.status(result.reused ? 200 : 201).json(result);
  });

  // WC-37 (PLAN §9 #9): on-demand context compaction. Refreshes the
  // continuation-summary document for the issue based on its most recent
  // run. The summary is an LLM-readable distillation of where the work
  // stands — useful when a long-running issue's session is about to
  // rotate or when a human wants a fresh "what's been done so far?" view.
  router.post("/issues/:id/compact-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    // WC-215: cap expensive LLM context-compaction runs per tenant.
    if (!enforceLlmRouteRateLimit(req, res, llmRateLimiter, issue.companyId)) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;

    const runId = (issue as any).executionRunId ?? (issue as any).checkoutRunId ?? null;
    if (!runId) {
      res.status(409).json({
        error: "no run to compact from — start a run for this issue first",
        code: "no_run_available",
      });
      return;
    }

    const runRow = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
        error: heartbeatRuns.error,
        resultJson: heartbeatRuns.resultJson,
        stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
        stderrExcerpt: heartbeatRuns.stderrExcerpt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!runRow) {
      res.status(409).json({
        error: "run referenced by issue.executionRunId no longer exists",
        code: "run_missing",
      });
      return;
    }

    const agentRow = await agentsSvc.getById(runRow.agentId);
    if (!agentRow) {
      res.status(409).json({
        error: "agent that owned the run no longer exists",
        code: "agent_missing",
      });
      return;
    }

    const summary = await refreshIssueContinuationSummary({
      db,
      issueId: issue.id,
      run: {
        id: runRow.id,
        status: runRow.status,
        error: runRow.error,
        resultJson: runRow.resultJson ?? null,
        stdoutExcerpt: runRow.stdoutExcerpt,
        stderrExcerpt: runRow.stderrExcerpt,
        finishedAt: runRow.finishedAt,
      },
      agent: {
        id: agentRow.id,
        name: agentRow.name,
        adapterType: agentRow.adapterType ?? null,
      },
    });
    if (!summary) {
      res.status(500).json({ error: "failed to refresh continuation summary" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId ?? "system",
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.context_compacted",
      entityType: "issue",
      entityId: issue.id,
      details: { compactedRunId: runRow.id, summaryDocumentId: summary.id },
    });

    res.status(200).json({ summary });
  });

  router.patch("/work-products/:id", validate(updateIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
    // WC-199 (security): a design's reviewState/isPrimary are BOARD-governed
    // transitions with dedicated gated routes (submit → needs_board_review, and the
    // assertBoard-only /design-review/approve · /request-changes). This generic
    // PATCH is reachable by the issue's assigned AGENT (assertAgentIssueMutationAllowed),
    // so accepting those keys here let an agent self-approve its own source-of-truth
    // design and walk straight past the design-first Done gate (also skipping the
    // needs_board_review→approved transition validation + autoDeleteSupersededDesigns
    // cleanup). Reject them on design-type products; force the governed routes.
    // (Mirrors createDesignArtifactSchema, which already pins client reviewState to "none".)
    if (
      isDesignWorkProductType(existing.type) &&
      (req.body.reviewState !== undefined || req.body.isPrimary !== undefined)
    ) {
      res.status(422).json({
        error:
          "design reviewState/isPrimary are board-governed — use the design-review routes (submit · approve · request-changes)",
        code: "design_review_route_required",
      });
      return;
    }
    const product = await workProductsSvc.update(id, req.body);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, changedKeys: Object.keys(req.body).sort() },
    });
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "work_product",
      actor,
      workProductChanged: true,
    });
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
    const removed = await workProductsSvc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: removed.id, type: removed.type },
    });
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "work_product",
      actor,
      workProductChanged: true,
    });
    res.json(removed);
  });

  // ───────────────────────────────────────────────────────────────────────
  // WC-182 / D22: the design-review gate (HTTP API).
  // The isPrimary design-type work product on an issue IS that issue's
  // source-of-truth design, and reviewState is its review gate (Slice 1 added
  // the service methods). These endpoints expose the gate over HTTP:
  //   submit          → promote to authoritative + reviewState needs_board_review
  //   approve         → reviewState approved          (board decision)
  //   request-changes → reviewState changes_requested (board decision)
  // The Slice-1 service THROWS on an invalid transition or a non-design type.
  // respondDesignReviewError maps those domain errors to 4xx instead of a 500:
  //   non-design type            → 422 Unprocessable Entity
  //   invalid review transition  → 409 Conflict
  // Anything else is rethrown so the central error handler still surfaces real
  // bugs as 500s.
  function respondDesignReviewError(res: Response, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (/not a design type/.test(message)) {
      res.status(422).json({ error: message });
      return;
    }
    if (/Invalid design review transition/.test(message)) {
      res.status(409).json({ error: message });
      return;
    }
    throw err;
  }

  // Body for request-changes: an optional free-text reason recorded on the
  // activity event. Kept inline (single small field) consistent with other
  // narrow route bodies in this file; the shared work-product create/update
  // schemas stay the canonical home for the work-product shape itself.
  const designReviewRequestChangesSchema = z.object({
    reason: z.string().trim().max(2000).optional(),
  });

  // Submit the issue's design for board review. The designer (agent) or the
  // board may call this. Promotes the work product to its issue's authoritative
  // (source-of-truth) design, then advances the review gate to
  // needs_board_review. Mirrors the PATCH handler's lookup + agent-mutation
  // guards, scoped to the work product's companyId.
  router.post("/work-products/:id/design-review/submit", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;

    // GAP 1 (designer self-verify, no headless browser): a cheap, deterministic
    // conformance gate. If the 시안 HTML is resolvable (a data:text/html URL OR a
    // short /api/assets/<id>/content URL), run it through the EXISTING pure
    // extractDesignSystem() and reject the submit when it is obviously
    // empty/degenerate (zero colors AND zero font sizes = not a real design).
    // This only blocks the obviously-empty case — a real 시안 with any colors or
    // font sizes passes. Non-resolvable / non-HTML URLs (live links, image data
    // URLs) skip the gate gracefully.
    const decodedSianHtml = await resolveSianHtmlForCompany(existing.url, issue.companyId);
    if (decodedSianHtml !== null) {
      const ds = extractDesignSystem(decodedSianHtml);
      if (ds.colors.length === 0 && ds.fontSizes.length === 0) {
        res.status(422).json({
          error:
            "This 시안 looks empty — no colors or font sizes were detected in its HTML. Render and self-review the design against the visual quality bar and the project's design-system tokens, then resubmit.",
          code: "degenerate_design",
        });
        return;
      }
    }

    let product: Awaited<ReturnType<typeof workProductsSvc.setDesignReviewState>>;
    try {
      await workProductsSvc.setAuthoritativeDesign(id);
      product = await workProductsSvc.setDesignReviewState(id, "needs_board_review");
    } catch (err) {
      respondDesignReviewError(res, err);
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.design_review_submitted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, reviewState: product.reviewState },
    });
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "work_product",
      actor,
      workProductChanged: true,
    });
    res.json(product);
  });

  // Board decision: approve the submitted design as the confirmed source of
  // truth. Board-only (assertBoard), scoped to the work product's companyId.
  router.post("/work-products/:id/design-review/approve", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    let product: Awaited<ReturnType<typeof workProductsSvc.setDesignReviewState>>;
    try {
      product = await workProductsSvc.setDesignReviewState(id, "approved");
    } catch (err) {
      respondDesignReviewError(res, err);
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.design_review_approved",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, reviewState: product.reviewState },
    });
    // Mirror request-changes: the approval rides the wake as a comment so the
    // woken assignee's task prompt says WHAT was decided ("approved — build
    // against it") instead of forcing an API hunt.
    let approvalCommentId: string | null = null;
    try {
      const approvalComment = await svc.addComment(
        existing.issueId,
        `Design review: "${product.title}" approved — it is now the source-of-truth implementation target. Build and verify against it.`,
        actor.actorType === "agent"
          ? { agentId: actor.actorId, runId: actor.runId ?? null }
          : { userId: actor.actorId },
      );
      approvalCommentId = approvalComment.id;
    } catch (err) {
      logger.warn(
        { err, issueId: existing.issueId, workProductId: product.id },
        "failed to record design approval as an issue comment",
      );
    }
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "work_product",
      actor,
      workProductChanged: true,
    });
    queueDesignReviewResolutionWakeup({
      heartbeat,
      issue,
      workProductId: product.id,
      decision: "approved",
      actor,
      commentId: approvalCommentId,
    });
    res.json(product);
  });

  // Board decision: request changes, routing the design back to the designer
  // leg. Board-only (assertBoard), scoped to the work product's companyId. The
  // optional reason is recorded on the activity event.
  router.post(
    "/work-products/:id/design-review/request-changes",
    validate(designReviewRequestChangesSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await workProductsSvc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Work product not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      const issue = await svc.getById(existing.issueId);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      // GAP 1+2: send the DESIGN back to the designer. Normally board-only, but
      // the QA reviewer holding the issue in_review may also escalate a 시안 it
      // finds inadequate — relax for the CURRENT execution-stage review
      // participant of THIS issue, only while in_review. The relaxation is
      // tightly scoped: only request-changes (never approve), only the current
      // participant, only in_review. Any other agent → 403. (approve stays
      // board-only — see that route.)
      if (req.actor.type !== "board") {
        const executionState = parseIssueExecutionState(issue.executionState);
        const currentParticipant = executionState?.currentParticipant ?? null;
        const isCurrentReviewParticipant =
          req.actor.type === "agent" &&
          !!req.actor.agentId &&
          issue.status === "in_review" &&
          currentParticipant?.type === "agent" &&
          currentParticipant.agentId === req.actor.agentId;
        if (!isCurrentReviewParticipant) {
          throw forbidden(
            "Only the board or the current in_review review participant may request design changes",
          );
        }
      }

      let product: Awaited<ReturnType<typeof workProductsSvc.setDesignReviewState>>;
      try {
        product = await workProductsSvc.setDesignReviewState(id, "changes_requested");
      } catch (err) {
        respondDesignReviewError(res, err);
        return;
      }

      const reason = (req.body as { reason?: string }).reason ?? null;
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.design_review_changes_requested",
        entityType: "issue",
        entityId: existing.issueId,
        details: { workProductId: product.id, reason },
      });
      // The board's reason must reach the designer IN the task prompt, not
      // just the audit log: post the decision as an issue comment and ride it
      // on the wake below. Best-effort — a comment failure must not undo the
      // review-state transition that already happened.
      let decisionCommentId: string | null = null;
      try {
        const decisionComment = await svc.addComment(
          existing.issueId,
          [
            `Design review: changes requested on "${product.title}".`,
            ...(reason ? ["", reason] : []),
          ].join("\n"),
          actor.actorType === "agent"
            ? { agentId: actor.actorId, runId: actor.runId ?? null }
            : { userId: actor.actorId },
        );
        decisionCommentId = decisionComment.id;
      } catch (err) {
        logger.warn(
          { err, issueId: existing.issueId, workProductId: product.id },
          "failed to record design change-request reason as an issue comment",
        );
      }
      await revalidateActiveSourceRecoveryAfterCommittedWrite({
        issue,
        trigger: "work_product",
        actor,
        workProductChanged: true,
      });
      // Design rework is the DESIGNER's job. During in_review issue.assigneeAgentId
      // is the QA reviewer, so the default assignee wake would make QA redo the
      // 시안 — resolve the designer (the design_request child's assignee, else a
      // designer-role agent) and route the change request there instead.
      const designerAgentId = await resolveDesignChangeDesigner(db, existing.companyId, existing.issueId);
      queueDesignReviewResolutionWakeup({
        heartbeat,
        issue,
        workProductId: product.id,
        decision: "changes_requested",
        actor,
        commentId: decisionCommentId,
        designerAgentId,
      });
      res.json(product);
    },
  );

  // WC-194 (revises WC-192 per user direction — 이전 버전 삭제): HARD-DELETE a
  // superseded design work product so it drops out of the catalog entirely.
  // Board-only. Irreversible — only the mockup row is removed; the issue's
  // design-spec document + current authoritative design are separate and stay.
  router.post("/work-products/:id/delete", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, existing.companyId);

    try {
      await workProductsSvc.deleteDesign(id);
    } catch (err) {
      respondDesignReviewError(res, err);
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.design_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: id, title: existing.title },
    });
    res.json({ ok: true, deletedId: id });
  });

  // WC-195: set an issue's design requirement — the design-first gate opt-out.
  // Default (no record) = design REQUIRED, so a non-exempt issue cannot reach
  // Done without an approved source-of-truth design. POSTing { required:false,
  // reason } EXEMPTS the issue (e.g. obvious backend-only work). Callable by the
  // board OR by an AI agent (orchestrator/planner) — when an agent sets it the
  // record is tagged setByKind:"auto". Audit-logged.
  router.post("/issues/:id/design-requirement", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    // WC-199: validate the body instead of loosely coercing — a stringified
    // "false" (or any non-boolean) previously coerced to required:true silently.
    const parsedRequirement = z
      .object({
        required: z.boolean().optional(),
        reason: z.string().trim().max(2000).nullable().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsedRequirement.success) {
      res.status(400).json({
        error: "invalid design-requirement body",
        details: parsedRequirement.error.flatten(),
      });
      return;
    }
    const required = parsedRequirement.data.required !== false; // default true (required)
    const reason = parsedRequirement.data.reason ?? null;
    const actor = getActorInfo(req);
    const setByKind: "auto" | "manual" = actor.actorType === "agent" ? "auto" : "manual";
    const designRequirement = { required, reason, setByKind };
    await db
      .update(issueRows)
      .set({ designRequirement, updatedAt: new Date() })
      .where(eq(issueRows.id, id));
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.design_requirement_set",
      entityType: "issue",
      entityId: id,
      details: { required, reason, setByKind },
    });
    res.json({ ok: true, designRequirement });
  });

  // WC-188 / CP7: user feedback on a PLAN revises the plan/기획. This is the
  // PLAN-side mirror of the design request-changes→designer loop. "The plan" for
  // an issue is its description plus its plan/issue-draft document; this route
  // does NOT mutate either — it (1) RECORDS the feedback (a board comment carrying
  // the reason + an `issue.plan_revision_requested` activity event), which is the
  // lightweight "needs revision" signal, and (2) WAKES the planner-capable agent
  // on the issue with that feedback as the revision instruction, reusing the same
  // `heartbeat.wakeup(... wakeReason ...)` primitive the comment / design-changes
  // paths use. Board-only (the user gives feedback), tenant-scoped. If no
  // planner-capable agent exists → 409, mirroring the draft path.
  //
  // Body: a single small free-text field, kept inline like the sibling
  // design-review request-changes schema above.
  const planRevisionRequestSchema = z.object({
    feedback: z.string().trim().min(1).max(4000),
  });
  router.post(
    "/issues/:id/plan/request-revision",
    validate(planRevisionRequestSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertBoard(req);
      assertCompanyAccess(req, issue.companyId);

      // Resolve the planner-capable agent (planner/pm/orchestrator, else the lone
      // eligible agent) the same way the draft / autofill paths do. No planner →
      // 409, so the UI can surface the same "assign a planner first" guidance.
      const plannerId = resolvePlannerCapableAgentId(await agentsSvc.list(issue.companyId));
      if (!plannerId) {
        throw conflict(
          "no planner-capable agent: assign an active agent with a planner, pm, or orchestrator role before requesting a plan revision.",
        );
      }

      const feedback = String((req.body as { feedback?: string }).feedback ?? "").trim();
      const actor = getActorInfo(req);

      // Record the feedback as a board comment on the issue. The comment IS the
      // durable "the plan needs revision" signal and the carrier of the reason
      // text the planner reads (the same surface agents already watch).
      const comment = await svc.addComment(
        id,
        feedback,
        {
          agentId: actor.agentId ?? undefined,
          userId: actor.actorType === "user" ? actor.actorId : undefined,
          runId: actor.runId,
        },
        {
          authorType: actor.actorType === "agent" ? "agent" : "user",
        },
      );

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.plan_revision_requested",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          plannerAgentId: plannerId,
          commentId: comment.id,
          feedbackSnippet: feedback.slice(0, 120),
        },
      });

      // Wake the planner-capable agent with the feedback as the revision
      // instruction. Reuses the exact wakeup primitive the issue-comment /
      // design-changes paths use: a `reason` + `payload` + a `contextSnapshot`
      // carrying `wakeReason` and the feedback so the heartbeat run loop picks it
      // up as the work to do this turn.
      void heartbeat
        .wakeup(plannerId, {
          source: "automation",
          triggerDetail: "system",
          reason: "plan_revision_requested",
          payload: {
            issueId: issue.id,
            commentId: comment.id,
            mutation: "plan_revision",
            feedback,
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "plan_revision_requested",
            source: "issue.plan.request_revision",
            feedback,
          },
        })
        .catch((err) =>
          logger.warn(
            { err, issueId: issue.id, agentId: plannerId },
            "failed to wake planner on plan revision request",
          ),
        );

      res.status(201).json({ ok: true, comment, plannerAgentId: plannerId });
    },
  );

  // WC-182 / D22: in-product creation of a design-type work product (the
  // source-of-truth design candidate). The standard POST /issues/:id/work-products
  // validates against the NARROW issueWorkProductTypeSchema, which excludes the
  // design types — so before this route design artifacts could only be created
  // by the external Open Design daemon or a direct DB insert. This mirrors the
  // sibling create route (same lookup + company + agent-mutation guards) but
  // constrains `type` to the design-type set and pins status/reviewState to the
  // freshly-created values (active / none). createForIssue already enforces
  // per-type isPrimary uniqueness, so isPrimary:true makes this the issue's
  // authoritative source-of-truth design.
  router.post("/issues/:id/design-artifacts", validate(createDesignArtifactSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;
    // Design-system redesign: one artifact = one screen. Derive screenKey from
    // screenName when the agent omitted it; `links` (NOT a work-product column)
    // is stripped before insert and resolved into design_screen_links below.
    const links: { label?: string | null; targetScreenKey: string }[] = Array.isArray(req.body.links)
      ? req.body.links
      : [];
    const screenName = typeof req.body.screenName === "string" ? req.body.screenName : null;
    const screenKeyRaw = typeof req.body.screenKey === "string" ? req.body.screenKey.trim() : "";
    const resolvedScreenKey =
      screenKeyRaw || (screenName ? slugifyScreenKey(screenName) : null) || null;
    const resolvedProjectId = (req.body.projectId as string | null) ?? issue.projectId ?? null;
    const createData = {
      ...req.body,
      screenKey: resolvedScreenKey,
      screenName,
      status: "active",
      reviewState: "none",
      projectId: resolvedProjectId,
    };
    delete (createData as Record<string, unknown>).links;
    // R3: planMarkdown is the PAIRED "화면 기획" (screen plan) body, NOT a column
    // on the pure-screen 시안 row — strip it before insert and persist it as a
    // separate screen_plan work product below.
    const planMarkdown =
      typeof req.body.planMarkdown === "string" ? req.body.planMarkdown.trim() : "";
    delete (createData as Record<string, unknown>).planMarkdown;
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, createData);
    if (!product) {
      res.status(422).json({ error: "Invalid design artifact payload" });
      return;
    }
    // Persist the screen's declared outbound nav links (R3). Idempotent; only
    // when this artifact carries a screen identity to anchor the edges on.
    if (Array.isArray(links) && links.length > 0 && resolvedScreenKey) {
      await designFlowSvc.declareLinks({
        companyId: issue.companyId,
        projectId: resolvedProjectId,
        fromScreenKey: resolvedScreenKey,
        sourceWorkProductId: product.id,
        createdByKind: "agent",
        links,
      });
    }
    // R3: pair a "화면 기획" (screen plan) to this pure-screen 시안 when the agent
    // authored one. Same canonical screenKey → 1:1 pairing; upsert so a revision
    // updates the same plan row instead of forking. The plan is a non-design work
    // product, so it never becomes a flow node or holds the design gate.
    if (planMarkdown && resolvedScreenKey) {
      await workProductsSvc.upsertScreenPlan({
        issueId: issue.id,
        companyId: issue.companyId,
        projectId: resolvedProjectId,
        screenKey: resolvedScreenKey,
        screenName,
        planMarkdown,
      });
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.design_artifact_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type },
    });
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "work_product",
      actor,
      workProductChanged: true,
    });

    // WC-DSR (designer visual self-review): when a DESIGNER attaches a primary
    // 시안 (HTML mockup) that is not yet board-approved, render it to a PNG and
    // re-wake the designer with that screenshot as image input — so it SEES its
    // own design and reviews it against the quality bar before submitting. This
    // is best-effort and never blocks the attach response: the 시안 is already
    // stored, so a render failure (or no Chromium, or a non-HTML url) just skips
    // the loop with a logged note. Bounded by SIAN_SELF_REVIEW_ROUND_CAP to
    // prevent an infinite render↔revise loop.
    void maybeRunDesignSelfReview({ issue, product, actor }).catch((err) => {
      logger.warn(
        { err, issueId: issue.id, workProductId: product.id },
        "designer 시안 self-review render/wake failed; continuing without the visual loop",
      );
    });

    res.status(201).json(product);
  });

  // WC-DSR (designer visual self-review): the render+wake decision for a freshly
  // attached/updated 시안. Extracted from the design-artifacts route so the
  // explicit render route can reuse the gate. Returns the rendered PNG path when
  // a self-review wake was enqueued, else null (skipped — not a designer, not a
  // primary 시안, already approved, round cap reached, or non-renderable url).
  async function maybeRunDesignSelfReview(input: {
    issue: { id: string; companyId: string; executionWorkspaceId?: string | null };
    product: { id: string; type: string; url: string | null; isPrimary: boolean; reviewState: string; metadata: Record<string, unknown> | null };
    actor: ReturnType<typeof getActorInfo>;
  }): Promise<{ pngPath: string } | null> {
    // Only a designer-role AGENT attaching its OWN primary 시안 triggers the loop.
    if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;
    if (!input.product.isPrimary || !isDesignWorkProductType(input.product.type)) return null;
    // An already board-approved design is the implementation target — there is
    // nothing left for the designer to self-review.
    if (input.product.reviewState === "approved") return null;

    const designerRole = await db
      .select({ role: agents.role })
      .from(agents)
      .where(and(eq(agents.id, input.actor.agentId), eq(agents.companyId, input.issue.companyId)))
      .limit(1)
      .then((rows) => rows[0]?.role ?? null);
    if (designerRole !== "designer") return null;

    const priorRounds = readSelfReviewRounds(input.product.metadata);
    if (priorRounds >= SIAN_SELF_REVIEW_ROUND_CAP) {
      // Cap reached: stop re-waking. The submit gate still applies, so the
      // designer can submit; we record that the visual loop was exhausted.
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: "system",
        actorId: "system",
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.design_self_review_capped",
        entityType: "issue",
        entityId: input.issue.id,
        details: { workProductId: input.product.id, rounds: priorRounds, cap: SIAN_SELF_REVIEW_ROUND_CAP },
      });
      return null;
    }

    const workspaceCwd = await resolveIssueWorkspaceCwd(input.issue);
    const rendered = await renderAndStoreSianPreview({
      issueId: input.issue.id,
      companyId: input.issue.companyId,
      workProduct: input.product,
      workspaceCwd,
    });
    if (!rendered) return null; // url was not a renderable 시안 (data: or asset).

    const nextRound = priorRounds + 1;
    // Increment the round counter on the work product BEFORE waking, so a wake
    // that re-attaches sees the prior count and the cap actually bounds.
    await workProductsSvc.update(input.product.id, {
      metadata: { ...(input.product.metadata ?? {}), designSelfReviewRounds: nextRound },
    });
    await enqueueDesignSelfReviewWake({
      issue: input.issue,
      designerAgentId: input.actor.agentId,
      workProductId: input.product.id,
      pngPath: rendered.pngPath,
      round: nextRound,
    });
    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.actor.agentId,
      runId: input.actor.runId,
      action: "issue.design_self_review_requested",
      entityType: "issue",
      entityId: input.issue.id,
      details: { workProductId: input.product.id, round: nextRound, pngPath: rendered.pngPath },
    });
    return rendered;
  }

  // WC-DSR (designer visual self-review): explicit render endpoint. Renders a
  // 시안 (by workProductId, or raw html) to a PNG, writes it to the issue's
  // execution-workspace cwd (or the server preview dir), and returns the
  // absolute path. Optionally stores a `screenshot` work product so the
  // board/QA can view the render. This is the imperative counterpart to the
  // automatic self-review wake: an agent (or the UI) can request a render on
  // demand. Empty HTML → 422; a non-renderable url (live link) → 422.
  const designRenderSchema = z
    .object({
      workProductId: z.string().trim().min(1).optional(),
      html: z.string().min(1).optional(),
      // When true, also persist the render as a `screenshot` design work product
      // (non-primary, so it never clobbers the source-of-truth 시안).
      storeScreenshot: z.boolean().optional(),
    })
    .refine((body) => Boolean(body.workProductId) || Boolean(body.html), {
      message: "Provide either workProductId or html to render",
    });

  router.post("/issues/:id/design-render", validate(designRenderSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;

    const body = req.body as { workProductId?: string; html?: string; storeScreenshot?: boolean };
    let workProduct: { id: string; url: string | null } | null = null;
    if (body.workProductId) {
      const existing = await workProductsSvc.getById(body.workProductId);
      if (!existing || existing.issueId !== issue.id) {
        res.status(404).json({ error: "Work product not found for this issue" });
        return;
      }
      workProduct = { id: existing.id, url: existing.url };
    }
    // When rendering raw html (no work product), use a stable per-issue file
    // name so repeated ad-hoc renders overwrite in place.
    const renderTargetId = workProduct?.id ?? `inline-${issue.id}`;
    const workspaceCwd = await resolveIssueWorkspaceCwd(issue);

    let rendered: { pngPath: string } | null;
    try {
      rendered = await renderAndStoreSianPreview({
        issueId: issue.id,
        companyId: issue.companyId,
        workProduct: workProduct ?? { id: renderTargetId, url: null },
        workspaceCwd,
        html: body.html ?? null,
      });
    } catch (err) {
      if (err instanceof EmptySianHtmlError) {
        res.status(422).json({ error: err.message, code: "empty_sian" });
        return;
      }
      throw err;
    }
    if (!rendered) {
      res.status(422).json({
        error:
          "Nothing to render: provide inline html, or a workProductId whose 시안 is a self-contained HTML mockup (an inline data: URL or an uploaded asset URL). A live external link cannot be rendered here.",
        code: "unrenderable_sian",
      });
      return;
    }

    let screenshotWorkProductId: string | undefined;
    if (body.storeScreenshot) {
      const screenshot = await workProductsSvc.createForIssue(issue.id, issue.companyId, {
        type: "screenshot",
        provider: "workcell",
        title: "Rendered 시안 screenshot",
        // The rendered PNG lives on disk for the agent to Read; the work product
        // records its absolute path so the board/QA can locate it.
        url: null,
        status: "active",
        reviewState: "none",
        isPrimary: false,
        metadata: { kind: "sian_render", pngPath: rendered.pngPath, sourceWorkProductId: workProduct?.id ?? null },
        projectId: issue.projectId ?? null,
      });
      screenshotWorkProductId = screenshot?.id;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.design_rendered",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: workProduct?.id ?? null, pngPath: rendered.pngPath, screenshotWorkProductId: screenshotWorkProductId ?? null },
    });

    res.status(200).json({ pngPath: rendered.pngPath, ...(screenshotWorkProductId ? { screenshotWorkProductId } : {}) });
  });

  // WC-183a / D22 / D13: "기존 UI 스캔 → 디자인시스템 추출". Given a captured UI
  // sample (HTML — the realistic artifact of a scan), extract the design tokens
  // (colors/typography/spacing) + a light component inventory PURELY (no headless
  // browser, no CSS parser; the live-URL capture is a separate later slice), and
  // store the result as a design-type work product. The tokens live in
  // metadata.tokens; the preview (data URL) renders the palette / type scale.
  //
  // isPrimary is intentionally false: a design SYSTEM is a reference artifact,
  // distinct from a screen 시안. It must NOT auto-clobber the issue's
  // authoritative source-of-truth screen design.
  router.post("/issues/:id/design-system", validate(extractDesignSystemSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;

    const ds = extractDesignSystem(req.body.html);
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, {
      type: "design",
      provider: "workcell",
      title: req.body.title ?? "Design System (extracted)",
      url: designSystemToDataUrl(ds),
      status: "active",
      reviewState: "none",
      isPrimary: false,
      metadata: { kind: "design_system", tokens: ds },
      projectId: issue.projectId ?? null,
    });
    if (!product) {
      res.status(422).json({ error: "Invalid design system payload" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.design_system_extracted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        workProductId: product.id,
        colorCount: ds.sourceSummary.colorCount,
        fontFamilyCount: ds.fontFamilies.length,
        fontSizeCount: ds.fontSizes.length,
        spacingCount: ds.spacing.length,
        componentCount: ds.componentCounts.length,
        htmlBytes: ds.sourceSummary.htmlBytes,
      },
    });
    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "work_product",
      actor,
      workProductChanged: true,
    });
    res.status(201).json({ workProduct: product, designSystem: ds });
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.markUnread(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_unmarked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: issue.id, removed });
  });

  router.post("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const archiveState = await svc.archiveInbox(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_archived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, archivedAt: archiveState.archivedAt },
    });
    res.json(archiveState);
  });

  router.delete("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.unarchiveInbox(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_unarchived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json(removed ?? { ok: true });
  });

  router.get("/issues/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.json(approvals);
  });

  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    const actor = getActorInfo(req);
    await issueApprovalsSvc.link(id, req.body.approvalId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_linked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId: req.body.approvalId },
    });

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.status(201).json(approvals);
  });

  router.delete("/issues/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    await issueApprovalsSvc.unlink(id, approvalId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/issues", applyCreateIssueStatusDefault, validate(createIssueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));
    if (!(await assertCheapRecoveryIssueAssigneeProfileAllowed(req, res, { companyId }, req.body))) return;

    const actor = getActorInfo(req);
    // Project required: a user/board-created TOP-LEVEL issue must belong to a project,
    // otherwise its design system, execution workspace, and scope are ambiguous (it
    // would leak to company scope). Exempt: agent/system-created issues (they may be
    // legitimately company-scoped, e.g. recovery) and children (parentId) which inherit
    // the parent's project.
    {
      const requestedProjectId = typeof req.body.projectId === "string" ? req.body.projectId.trim() : "";
      if (actor.actorType === "user" && !req.body.parentId && !requestedProjectId) {
        throw unprocessable(
          "A project is required: assign this issue to a project so its design system and workspace are unambiguous.",
        );
      }
    }
    // Workcell philosophy: the board states direction; the Orchestrator routes it.
    // When the board (a user actor) creates a TOP-LEVEL issue without choosing an
    // assignee, default it to the company's orchestrator (lead fallback). The
    // unconditional queueIssueAssignmentWakeup below then auto-starts routing, so
    // this injection alone turns "board files an issue" into "orchestrator picks
    // it up". Guards: agent-created issues and child issues are never touched, and
    // explicit assignments are respected. The injected assignee still flows
    // through the assertCanAssignTasks check below (boards pass it).
    let autoRoutedToOrchestrator = false;
    if (
      actor.actorType === "user" &&
      !req.body.assigneeAgentId &&
      !req.body.assigneeUserId &&
      !req.body.parentId
    ) {
      // Team autonomy: company.autoRouteNewIssues (default ON) gates the
      // orchestrator injection. When the board turns it off, new issues stay
      // unassigned until a human routes them.
      const issueCreateCompany = await companiesSvc.getById(companyId);
      if (issueCreateCompany?.autoRouteNewIssues !== false) {
        const defaultOrchestratorId = resolveDefaultOrchestratorAgentId(
          (await agentsSvc.list?.(companyId)) ?? [],
        );
        if (defaultOrchestratorId) {
          req.body.assigneeAgentId = defaultOrchestratorId;
          autoRoutedToOrchestrator = true;
        }
      }
    }

    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, companyId, {
        projectId: await resolveAssignmentProjectId({
          companyId,
          projectId: req.body.projectId,
          parentIssueId: req.body.parentId,
        }),
        parentIssueId: req.body.parentId ?? null,
        assigneeAgentId: req.body.assigneeAgentId ?? null,
        assigneeUserId: req.body.assigneeUserId ?? null,
      });
    }
    await assertIssueEnvironmentSelection(companyId, req.body.executionWorkspaceSettings?.environmentId);

    const executionPolicy = applyActorMonitorScheduledBy(
      normalizeIssueExecutionPolicy(await resolveCreateExecutionPolicyInput(companyId, req.body)),
      actor.actorType,
    );
    assertCanManageIssueMonitor(req, req.body.assigneeAgentId ?? null, Boolean(executionPolicy?.monitor));
    const issue = await svc.create(companyId, {
      ...req.body,
      executionPolicy,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await issueReferencesSvc.syncIssue(issue.id);
    const referenceSummary = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
      issueReferencesSvc.emptySummary(),
      referenceSummary,
    );

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        title: issue.title,
        identifier: issue.identifier,
        ...buildCreateIssueActivityStatusDetails(issue, res),
        ...(autoRoutedToOrchestrator ? { autoRouted: true } : {}),
        ...(Array.isArray(req.body.blockedByIssueIds) ? { blockedByIssueIds: req.body.blockedByIssueIds } : {}),
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    if (executionPolicy?.monitor) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.monitor_scheduled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          nextCheckAt: executionPolicy.monitor.nextCheckAt,
          notes: executionPolicy.monitor.notes,
          scheduledBy: executionPolicy.monitor.scheduledBy,
          serviceName: executionPolicy.monitor.serviceName ?? null,
          timeoutAt: executionPolicy.monitor.timeoutAt ?? null,
          maxAttempts: executionPolicy.monitor.maxAttempts ?? null,
          recoveryPolicy: executionPolicy.monitor.recoveryPolicy ?? null,
        },
      });
    }

    // Dual-brain (phase A — retired): self-review is moving to the EXECUTION
    // layer (inside the heartbeat run) so it applies consistently to every
    // issue a deliberation-enabled agent runs, regardless of how it was
    // assigned. Binding a dual_brain pair group HERE was the source of two
    // bugs: (1) route-only coverage — child/recovery/interaction assignments
    // bypass this and ran single-brain; (2) the pair-round engine has no issue
    // execution lock, so it ran the agent's self-review CONCURRENTLY with the
    // issue's QA/execution stage (two agents on one issue). The group
    // auto-create is removed; deliberation agents run single-brain until the
    // execution-layer loop (phase B) lands.
    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    res.status(201).json({
      ...issue,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
    });
  });

  router.post(
    "/companies/:companyId/issues/draft-from-prompt",
    validate(draftIssueFromPromptSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      // WC-215: cap expensive natural-language→planner draft runs per tenant.
      if (!enforceLlmRouteRateLimit(req, res, llmRateLimiter, companyId)) return;

      const prompt = String(req.body.prompt ?? "").trim();
      const projectId = (req.body.projectId as string | null | undefined) ?? null;

      const plannerId = resolvePlannerCapableAgentId(await agentsSvc.list(companyId));
      if (!plannerId) {
        throw conflict(
          "no planner-capable agent: assign an active agent with a planner, pm, or orchestrator role before drafting.",
        );
      }

      const actor = getActorInfo(req);
      const company = await companiesSvc.getById(companyId);
      const planLanguageLabel = resolvePlanReportLanguageLabel(company?.planReportLanguage);
      const issue = await svc.create(companyId, {
        title: buildPlannerDraftTitle(prompt),
        description: buildPlannerDraftInstruction(prompt, planLanguageLabel),
        status: "todo",
        workMode: "planning",
        priority: "medium",
        assigneeAgentId: plannerId,
        projectId,
        originKind: "planner_draft_request",
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.created",
        entityType: "issue",
        entityId: issue.id,
        details: {
          title: issue.title,
          identifier: issue.identifier,
          originKind: "planner_draft_request",
          assigneeAgentId: plannerId,
        },
      });

      void queueIssueAssignmentWakeup({
        heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.draft_from_prompt",
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });

      res.status(201).json(issue);
    },
  );

  // WC-184 (CP0 "Grill mode"): interrogate the user BEFORE drafting. When the
  // planner-draft bar's Grill toggle is ON, the UI calls this instead of
  // draft-from-prompt: we run ONE planner adapter turn that returns the
  // highest-leverage clarifying questions (each with a recommended answer +
  // rationale) and reply with `{ questions: [...] }`. No issue is created here —
  // once the user answers, the UI appends the Q&A to the prompt and calls the
  // NORMAL draft route, so the planner drafts with the clarified intent.
  //
  // Mirrors the draft path's planner resolution (same eligible-agent rule) and
  // plan-report language threading (WC-81). The adapter is invoked synchronously
  // via the WC-57 single-turn seam (the planner agent's adapterType/config), so
  // the questions come back in this response rather than via the heartbeat run
  // loop the draft path uses. The reply is parsed defensively — a malformed /
  // empty / non-array model reply (or any adapter failure) yields an empty list,
  // never a 500.
  router.post(
    "/companies/:companyId/issues/draft-grill",
    validate(draftGrillFromPromptSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const prompt = String(req.body.prompt ?? "").trim();

      const agents = await agentsSvc.list(companyId);
      const plannerId = resolvePlannerCapableAgentId(agents);
      if (!plannerId) {
        throw conflict(
          "no planner-capable agent: assign an active agent with a planner, pm, or orchestrator role before drafting.",
        );
      }
      const planner = agents.find((agent) => agent.id === plannerId) ?? null;

      const company = await companiesSvc.getById(companyId);
      const planLanguageLabel = resolvePlanReportLanguageLabel(company?.planReportLanguage);
      const instruction = buildPlannerGrillInstruction(prompt, planLanguageLabel);

      let questions: PlannerGrillQuestion[] = [];
      try {
        const { stdout, result } = await runAdapterSingleTurn({
          adapterType: planner?.adapterType ?? "claude_local",
          runId: `grill-${randomUUID()}`,
          agent: {
            id: plannerId,
            companyId,
            name: planner?.name ?? "Planner",
            adapterType: planner?.adapterType ?? "claude_local",
            adapterConfig: planner?.adapterConfig ?? {},
          },
          config:
            planner?.adapterConfig && typeof planner.adapterConfig === "object"
              ? (planner.adapterConfig as Record<string, unknown>)
              : {},
          // The grill instruction rides on context.workcellTaskMarkdown — the
          // same key the draft/pair paths use to fold the prompt into the turn.
          context: { workcellTaskMarkdown: instruction },
        });
        // Only trust the reply on a clean turn; an adapter-level failure
        // (timeout / non-zero exit / error) yields no questions rather than a 500.
        if (!result.timedOut && (result.exitCode ?? 0) === 0 && !result.errorMessage) {
          const text = stdout.trim().length > 0 ? stdout : result.summary ?? "";
          questions = parsePlannerGrillQuestions(text);
        }
      } catch (err) {
        // Never let an adapter exception surface as a 500 — the UI's escape
        // hatch ("draft without answers") keeps the flow usable on failure.
        logger.warn({ err, companyId }, "planner grill turn failed; returning no questions");
        questions = [];
      }

      res.status(200).json({ questions });
    },
  );

  router.post("/issues/:id/children", applyCreateIssueStatusDefault, validate(createChildIssueSchema), async (req, res) => {
    const parentId = req.params.id as string;
    const parent = await svc.getById(parentId);
    if (!parent) {
      res.status(404).json({ error: "Parent issue not found" });
      return;
    }
    assertCompanyAccess(req, parent.companyId);
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));
    if (!(await assertCheapRecoveryIssueAssigneeProfileAllowed(req, res, parent, req.body))) return;
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, parent.companyId, {
        projectId: req.body.projectId ?? parent.projectId ?? null,
        parentIssueId: parent.id,
        assigneeAgentId: req.body.assigneeAgentId ?? null,
        assigneeUserId: req.body.assigneeUserId ?? null,
      });
    }
    await assertIssueEnvironmentSelection(parent.companyId, req.body.executionWorkspaceSettings?.environmentId);

    const actor = getActorInfo(req);
    const executionPolicy = applyActorMonitorScheduledBy(
      normalizeIssueExecutionPolicy(await resolveCreateExecutionPolicyInput(parent.companyId, req.body)),
      actor.actorType,
    );
    assertCanManageIssueMonitor(req, req.body.assigneeAgentId ?? null, Boolean(executionPolicy?.monitor));
    const { issue, parentBlockerAdded } = await svc.createChild(parent.id, {
      ...req.body,
      executionPolicy,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      actorAgentId: actor.agentId,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: parent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.child_created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        parentId: parent.id,
        identifier: issue.identifier,
        title: issue.title,
        ...buildCreateIssueActivityStatusDetails(issue, res),
        inheritedExecutionWorkspaceFromIssueId: parent.id,
        ...(Array.isArray(req.body.blockedByIssueIds) ? { blockedByIssueIds: req.body.blockedByIssueIds } : {}),
        ...(parentBlockerAdded ? { parentBlockerAdded: true } : {}),
      },
    });

    if (executionPolicy?.monitor) {
      await logActivity(db, {
        companyId: parent.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.monitor_scheduled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          parentId: parent.id,
          nextCheckAt: executionPolicy.monitor.nextCheckAt,
          notes: executionPolicy.monitor.notes,
          scheduledBy: executionPolicy.monitor.scheduledBy,
          serviceName: executionPolicy.monitor.serviceName ?? null,
          timeoutAt: executionPolicy.monitor.timeoutAt ?? null,
          maxAttempts: executionPolicy.monitor.maxAttempts ?? null,
          recoveryPolicy: executionPolicy.monitor.recoveryPolicy ?? null,
        },
      });
    }

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.child_create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    res.status(201).json(issue);
  });

  router.post("/issues/:id/monitor/check-now", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    assertCanManageIssueMonitor(req, issue.assigneeAgentId, true);

    const actor = getActorInfo(req);
    await heartbeat.triggerIssueMonitor(issue.id, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
    });

    res.json({ ok: true });
  });

  router.post("/issues/:id/scheduled-retry/retry-now", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const actor = getActorInfo(req);
    const result = await heartbeat.retryScheduledRetryNow({
      issueId: issue.id,
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "issue.scheduled_retry_retry_now",
      entityType: "issue",
      entityId: issue.id,
      agentId: result.scheduledRetry?.agentId ?? issue.assigneeAgentId ?? null,
      runId: result.scheduledRetry?.runId ?? null,
      details: {
        outcome: result.outcome,
        message: result.message,
        scheduledRetry: result.scheduledRetry,
      },
    });

    res.json(result);
  });

  router.patch("/issues/:id", validate(updateIssueRouteSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    if (!(await assertCheapRecoveryIssueAssigneeProfileAllowed(req, res, existing, req.body))) return;

    // WC-7: fire the proof gate at submit time (not only when svc.update sees a
    // resolved status:done). With a sign-off policy, the executor's "done" reroutes
    // to in_review/QA → the late gate fires only after the reviewer/approver
    // approves, i.e. AFTER review effort was already spent. Fail fast here so the
    // user attaches proof BEFORE submission. The late gate in svc.update stays as
    // a defense-in-depth safety net for internal callers.
    // Optional-chained against a partially-mocked workProductService (some route
    // tests stub it as `{}`): a missing method returns undefined → skip the early
    // gate and let the canonical late check in svc.update handle it. An explicit
    // `false` from the real service is the proof-missing signal.
    if (
      req.body.status === "done" &&
      existing.status !== "done" &&
      typeof workProductsSvc.hasProofForIssue === "function" &&
      issueRequiresProofForDone(existing)
    ) {
      const hasProof = await workProductsSvc.hasProofForIssue(existing.id, existing.companyId);
      if (!hasProof) {
        throw conflict("done requires a proof bundle", { code: "proof_required", issueId: existing.id });
      }
    }

    // WC-187 / CP6: design-first gate at submit time, mirroring the early proof
    // gate above (and the canonical late gate in svc.update). Block completing
    // development while the source-of-truth design exists but is NOT board-approved
    // (deriveIssueDesignGate(...).developmentHold). Reuses the same listForIssue +
    // deriveIssueDesignGate projection the heartbeat-context surface already runs,
    // so the held reason the UI shows (designGate) and the block reason agree.
    // Optional-chained against a partially-mocked workProductService (route tests
    // may stub it as `{}`): a missing method → skip here and let svc.update's
    // canonical gate decide. ADDITIVE + gated: no authoritative design, or an
    // approved one → developmentHold is false → no-op (non-design issues unchanged).
    if (
      req.body.status === "done" &&
      existing.status !== "done" &&
      typeof workProductsSvc.deriveDesignGateForIssue === "function" &&
      // WC-199: mirror the early proof gate's exemption (planning/recovery issues
      // are inherently non-screen → never design-gated).
      issueRequiresProofForDone(existing)
    ) {
      // WC-195: company + issue-aware design gate. Design is required when the
      // company opts in (companies.require_design_first) unless the issue is
      // explicitly exempt (issues.design_requirement = { required:false }).
      // deriveDesignGateForIssue reads both; the pure deriveIssueDesignGate did
      // not, so a required-but-undesigned issue used to slip past this early gate.
      const designGate = await workProductsSvc.deriveDesignGateForIssue(
        existing.id,
        existing.companyId,
      );
      if (designGate.developmentHold) {
        throw conflict(
          "An approved source-of-truth design is required before completing this issue " +
            "(create + board-approve a design, or mark the issue design-exempt).",
          { code: "design_review_pending", issueId: existing.id },
        );
      }
    }

    const actor = getActorInfo(req);
    const isClosed = isClosedIssueStatus(existing.status);
    const isBlocked = existing.status === "blocked";
    const normalizedAssigneeAgentId = await normalizeIssueAssigneeAgentReference(
      existing.companyId,
      req.body.assigneeAgentId as string | null | undefined,
    );
    const titleOrDescriptionChanged = req.body.title !== undefined || req.body.description !== undefined;
    const existingRelations =
      Array.isArray(req.body.blockedByIssueIds)
        ? await svc.getRelationSummaries(existing.id)
        : null;
    const {
      comment: commentBody,
      reviewRequest,
      reopen: reopenRequested,
      resume: resumeRequested,
      interrupt: interruptRequested,
      hiddenAt: hiddenAtRaw,
      ...updateFields
    } = req.body;
    const shouldCancelActiveRunForCancelledStatus =
      existing.status !== "cancelled" && updateFields.status === "cancelled";
    if (resumeRequested === true && !commentBody) {
      res.status(400).json({ error: "Follow-up intent requires a comment" });
      return;
    }
    if (resumeRequested === true && !(await assertExplicitResumeIntentAllowed(req, res, existing))) return;
    if (resumeRequested !== true && reopenRequested === true && req.actor.type === "agent") {
      if (!(await assertExplicitResumeIntentAllowed(req, res, existing))) return;
    }
    await assertIssueEnvironmentSelection(existing.companyId, updateFields.executionWorkspaceSettings?.environmentId);
    const requestedAssigneeAgentId =
      normalizedAssigneeAgentId === undefined ? existing.assigneeAgentId : normalizedAssigneeAgentId;
    const explicitMoveToTodoRequested = reopenRequested || resumeRequested === true;
    const recoveryRelevantSourceMutationRequested =
      req.body.status !== undefined ||
      normalizedAssigneeAgentId !== undefined ||
      req.body.assigneeUserId !== undefined ||
      Array.isArray(req.body.blockedByIssueIds) ||
      req.body.executionPolicy !== undefined ||
      explicitMoveToTodoRequested;
    const activeRecoveryActionBeforeUpdate = recoveryRelevantSourceMutationRequested
      ? await recoveryActionsSvc.getActiveForIssue(existing.companyId, existing.id)
      : null;
    if (
      recoveryRelevantSourceMutationRequested &&
      !(await assertRecoveryActionAuthority(
        req,
        res,
        existing,
        activeRecoveryActionBeforeUpdate,
        { source: "issue_update" },
      ))
    ) {
      return;
    }
    const scheduledRetryForHumanComment =
      shouldHumanCommentResumeInProgressScheduledRetry({
        hasComment: !!commentBody,
        issueStatus: existing.status,
        assigneeAgentId: requestedAssigneeAgentId,
        actorType: actor.actorType,
      })
        ? await svc.getCurrentScheduledRetry(existing.id)
        : null;
    const shouldResumeInProgressScheduledRetry =
      !!scheduledRetryForHumanComment &&
      scheduledRetryForHumanComment.agentId === requestedAssigneeAgentId;
    const effectiveMoveToTodoRequested =
      explicitMoveToTodoRequested ||
      (!!commentBody &&
        shouldImplicitlyMoveCommentedIssueToTodo({
          issueStatus: existing.status,
          assigneeAgentId: requestedAssigneeAgentId,
          actorType: actor.actorType,
          actorId: actor.actorId,
        })) ||
      shouldResumeInProgressScheduledRetry;
    const updateReferenceSummaryBefore = titleOrDescriptionChanged
      ? await issueReferencesSvc.listIssueReferenceSummary(existing.id)
      : null;
    const hasUnresolvedFirstClassBlockers =
      isBlocked && effectiveMoveToTodoRequested
        ? (await svc.getDependencyReadiness(existing.id)).unresolvedBlockerCount > 0
        : false;
    if (resumeRequested === true && isBlocked && hasUnresolvedFirstClassBlockers) {
      res.status(409).json({ error: "Issue follow-up blocked by unresolved blockers" });
      return;
    }
    let interruptedRunId: string | null = null;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(existing);
    const isAgentWorkUpdate =
      req.actor.type === "agent" && (Object.keys(updateFields).length > 0 || reviewRequest !== undefined);

    if (closedExecutionWorkspace && (commentBody || isAgentWorkUpdate)) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    if (interruptRequested) {
      if (!commentBody) {
        res.status(400).json({ error: "Interrupt is only supported when posting a comment" });
        return;
      }
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(existing);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: existing.id },
          });
        }
      }
    }

    const runToCancelForCancelledStatus = shouldCancelActiveRunForCancelledStatus
      ? await resolveActiveIssueRun(existing)
      : null;

    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
    }
    if (
      commentBody &&
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers) || shouldResumeInProgressScheduledRetry) &&
      updateFields.status === undefined
    ) {
      updateFields.status = "todo";
    }
    let cancelledScheduledRetryRunId: string | null = null;
    if (
      commentBody &&
      shouldResumeInProgressScheduledRetry &&
      updateFields.status === "todo"
    ) {
      cancelledScheduledRetryRunId = await cancelScheduledRetrySupersededByComment({
        scheduledRetryRunId: scheduledRetryForHumanComment?.runId,
        issue: existing,
        actor,
      });
    }
    if (req.body.executionPolicy !== undefined) {
      updateFields.executionPolicy = applyActorMonitorScheduledBy(
        normalizeIssueExecutionPolicy(req.body.executionPolicy),
        actor.actorType,
      );
    }
    const previousExecutionPolicy = normalizeIssueExecutionPolicy(existing.executionPolicy ?? null);

    // WC-6: default the QA-review signoff when this PATCH is the first agent assignment
    // on an execution-mode issue that has no policy yet (completes WC-5's create-time
    // injection for the unassigned-then-assign-later UX flow).
    const wc6InjectedPolicy = await resolveAssignmentDefaultPolicy({
      companyId: existing.companyId,
      workMode: existing.workMode,
      hasExistingPolicy: previousExecutionPolicy !== null,
      hasIncomingPolicy: req.body.executionPolicy !== undefined,
      newAssigneeAgentId: normalizedAssigneeAgentId,
    });
    if (wc6InjectedPolicy) {
      updateFields.executionPolicy = applyActorMonitorScheduledBy(
        normalizeIssueExecutionPolicy(wc6InjectedPolicy),
        actor.actorType,
      );
    }

    const nextExecutionPolicy =
      updateFields.executionPolicy !== undefined
        ? (updateFields.executionPolicy as NormalizedExecutionPolicy | null)
        : previousExecutionPolicy;
    if (normalizedAssigneeAgentId !== undefined) {
      updateFields.assigneeAgentId = normalizedAssigneeAgentId;
    }
    const monitorChanged = monitorPoliciesEqual(previousExecutionPolicy, nextExecutionPolicy) === false;
    assertCanManageIssueMonitor(req, existing.assigneeAgentId, req.body.executionPolicy !== undefined && monitorChanged);

    // Autonomous (unattended) mode: when enabled, user-participation execution
    // stages auto-approve so the workflow runs without a human in the loop. The
    // flag only changes behavior when the policy actually has a user-only stage,
    // so only pay for the instance-settings read in that case.
    const autonomousMode =
      nextExecutionPolicy?.stages.some(stageIsUserOnly)
        ? (await instanceSettings.getExperimental()).autonomousMode
        : false;

    const transition = applyIssueExecutionPolicyTransition({
      issue: existing,
      policy: nextExecutionPolicy,
      previousPolicy: previousExecutionPolicy,
      requestedStatus: typeof updateFields.status === "string" ? updateFields.status : undefined,
      skipUserParticipation: autonomousMode,
      requestedAssigneePatch: {
        assigneeAgentId: normalizedAssigneeAgentId,
        assigneeUserId:
          req.body.assigneeUserId === undefined ? undefined : (req.body.assigneeUserId as string | null),
      },
      actor: {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
      commentBody,
      reviewRequest: reviewRequest === undefined ? undefined : reviewRequest,
      monitorExplicitlyUpdated: req.body.executionPolicy !== undefined && monitorChanged,
    });
    const decisionId = transition.decision ? randomUUID() : null;
    if (decisionId) {
      const nextExecutionState = transition.patch.executionState;
      if (!nextExecutionState || typeof nextExecutionState !== "object") {
        throw new Error("Execution policy decision patch is missing executionState");
      }
      transition.patch.executionState = {
        ...nextExecutionState,
        lastDecisionId: decisionId,
      };
    }
    Object.assign(updateFields, transition.patch);
    if (reviewRequest !== undefined && transition.patch.executionState === undefined) {
      const existingExecutionState = parseIssueExecutionState(existing.executionState);
      if (!existingExecutionState || existingExecutionState.status !== "pending") {
        if (reviewRequest !== null) {
          res.status(422).json({ error: "reviewRequest requires an active review or approval stage" });
          return;
        }
      } else {
        updateFields.executionState = {
          ...existingExecutionState,
          reviewRequest,
        };
      }
    }

    await assertAgentInReviewReviewPath({
      existing,
      updateFields,
      actorType: req.actor.type,
    });

    const nextAssigneeAgentId =
      updateFields.assigneeAgentId === undefined ? existing.assigneeAgentId : (updateFields.assigneeAgentId as string | null);
    const nextAssigneeUserId =
      updateFields.assigneeUserId === undefined ? existing.assigneeUserId : (updateFields.assigneeUserId as string | null);
    const assigneeWillChange =
      nextAssigneeAgentId !== existing.assigneeAgentId || nextAssigneeUserId !== existing.assigneeUserId;
    const isAgentReturningIssueToCreator =
      req.actor.type === "agent" &&
      !!req.actor.agentId &&
      existing.assigneeAgentId === req.actor.agentId &&
      nextAssigneeAgentId === null &&
      typeof nextAssigneeUserId === "string" &&
      !!existing.createdByUserId &&
      nextAssigneeUserId === existing.createdByUserId;

    if (assigneeWillChange && !transition.workflowControlledAssignment) {
      if (!isAgentReturningIssueToCreator) {
        await assertCanAssignTasks(req, existing.companyId, {
          issueId: existing.id,
          projectId: await resolveAssignmentProjectId({
            companyId: existing.companyId,
            projectId: updateFields.projectId === undefined
              ? existing.projectId
              : updateFields.projectId as string | null | undefined,
            parentIssueId: (updateFields.parentId === undefined
              ? existing.parentId
              : updateFields.parentId) as string | null | undefined,
          }),
          parentIssueId: (updateFields.parentId === undefined
            ? existing.parentId
            : updateFields.parentId) as string | null | undefined,
          assigneeAgentId: nextAssigneeAgentId,
          assigneeUserId: nextAssigneeUserId,
        });
      }
    }

    // WC-163: when this PATCH modifies executionState, pass the version it was read at
    // so svc.update can reject a concurrent executionState change (optimistic
    // concurrency on an integer version — no jsonb serialization mismatch).
    const expectedExecutionStateVersion =
      updateFields.executionState !== undefined ? (existing.executionStateVersion ?? 0) : undefined;
    let issue;
    try {
      if (transition.decision && decisionId) {
        const decision = transition.decision;
        issue = await db.transaction(async (tx) => {
          const updated = await svc.update(
            id,
            {
              ...updateFields,
              actorAgentId: actor.agentId ?? null,
              actorUserId: actor.actorType === "user" ? actor.actorId : null,
              expectedExecutionStateVersion,
            },
            tx,
          );
          if (!updated) return null;

          await tx.insert(issueExecutionDecisions).values({
            id: decisionId,
            companyId: updated.companyId,
            issueId: updated.id,
            stageId: decision.stageId,
            stageType: decision.stageType,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
            outcome: decision.outcome,
            body: decision.body,
            createdByRunId: actor.runId ?? null,
          });

          return updated;
        });
      } else {
        issue = await svc.update(id, {
          ...updateFields,
          actorAgentId: actor.agentId ?? null,
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
          expectedExecutionStateVersion,
        });
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            issueId: id,
            companyId: existing.companyId,
            assigneePatch: {
              assigneeAgentId: normalizedAssigneeAgentId === undefined ? "__omitted__" : normalizedAssigneeAgentId,
              assigneeUserId:
                req.body.assigneeUserId === undefined ? "__omitted__" : req.body.assigneeUserId,
            },
            currentAssignee: {
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
            },
            error: err.message,
            details: err.details,
          },
          "issue update rejected with 422",
        );
      }
      throw err;
    }
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    let cancelledStatusRunId: string | null = null;
    if (runToCancelForCancelledStatus) {
      try {
        const cancelled = await heartbeat.cancelRun(runToCancelForCancelledStatus.id);
        if (cancelled) {
          cancelledStatusRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_status_cancelled", issueId: existing.id },
          });
        }
      } catch (err) {
        logger.warn({ err, issueId: existing.id, runId: runToCancelForCancelledStatus.id }, "failed to cancel run for cancelled issue");
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "heartbeat.cancel_failed",
          entityType: "heartbeat_run",
          entityId: runToCancelForCancelledStatus.id,
          details: { source: "issue_status_cancelled", issueId: existing.id },
        });
      }
    }

    if (titleOrDescriptionChanged) {
      await issueReferencesSvc.syncIssue(issue.id);
    }

    // WC-21: when this PATCH actually completed a fresh done-transition (and
    // a compound-checklist now exists from the WC-12 hook in svc.update), try
    // to kick off the Planner-driven auto-fill so the agent reviews while
    // context is fresh. Best-effort: silent when no planner-capable agent is
    // configured (the user can still trigger manually via the WC-19 route).
    // **Await the helper** so the autofill child is visible synchronously to
    // any caller polling the issue tree right after their mark-done click —
    // the helper is fast (a row insert + a wakeup queue) and waiting on it
    // avoids surprising "did it work?" gaps in the UI. Errors are swallowed
    // so a downstream failure never breaks the user's done click.
    const didJustReachDone =
      existing.status !== "done" &&
      issue.status === "done" &&
      issueRequiresProofForDone(existing);
    if (didJustReachDone) {
      try {
        await tryAutofillCompoundChecklist({
          parent: issue,
          actor,
          contextSource: "issue.compound_checklist_autofill.on_done",
        });
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id },
          "WC-21 auto-trigger of compound-checklist autofill failed (best-effort)",
        );
      }
    }

    const updateReferenceSummaryAfter = titleOrDescriptionChanged
      ? await issueReferencesSvc.listIssueReferenceSummary(issue.id)
      : null;
    const updateReferenceDiff = updateReferenceSummaryBefore && updateReferenceSummaryAfter
      ? issueReferencesSvc.diffIssueReferenceSummary(updateReferenceSummaryBefore, updateReferenceSummaryAfter)
      : null;
    let issueResponse: typeof issue & {
      blockedBy?: unknown;
      blocks?: unknown;
      activeRecoveryAction?: unknown;
      relatedWork?: Awaited<ReturnType<typeof issueReferencesSvc.listIssueReferenceSummary>>;
      referencedIssueIdentifiers?: string[];
    } = issue;
    let updatedRelations: Awaited<ReturnType<typeof svc.getRelationSummaries>> | null = null;
    if (issue && Array.isArray(req.body.blockedByIssueIds)) {
      updatedRelations = await svc.getRelationSummaries(issue.id);
      issueResponse = {
        ...issue,
        blockedBy: updatedRelations.blockedBy,
        blocks: updatedRelations.blocks,
      };
    }
    await routinesSvc.syncRunStatusForIssue(issue.id);

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue activity"));
    }

    // Build activity details with previous values for changed fields
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(updateFields)) {
      if (key in existing && (existing as Record<string, unknown>)[key] !== (updateFields as Record<string, unknown>)[key]) {
        previous[key] = (existing as Record<string, unknown>)[key];
      }
    }
    if (Array.isArray(req.body.blockedByIssueIds)) {
      previous.blockedByIssueIds = existingRelations?.blockedBy.map((relation) => relation.id) ?? [];
    }

    const hasFieldChanges = Object.keys(previous).length > 0;
    let workspaceChange = null;
    if (hasIssueWorkspaceAuditChange(previous)) {
      try {
        workspaceChange = await buildIssueWorkspaceChangeActivityDetails(db, issue.companyId, existing, issue);
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "failed to enrich issue workspace change activity details");
        const fallbackNames = emptyWorkspaceNameMaps();
        workspaceChange = {
          from: summarizeIssueWorkspaceForActivity(existing, fallbackNames),
          to: summarizeIssueWorkspaceForActivity(issue, fallbackNames),
        };
      }
    }
    const reopened =
      commentBody &&
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers)) &&
      previous.status !== undefined &&
      issue.status === "todo";
    const reopenFromStatus = reopened ? existing.status : null;
    const scheduledRetrySupersededByComment =
      shouldResumeInProgressScheduledRetry &&
      previous.status !== undefined &&
      existing.status === "in_progress" &&
      issue.status === "todo";
    const statusChangedFromBlockedToTodo =
      existing.status === "blocked" &&
      issue.status === "todo" &&
      (req.body.status !== undefined || reopened);
    const revalidatedRecoveryAction = await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue,
      trigger: "issue_update",
      actor,
      activeRecoveryAction: activeRecoveryActionBeforeUpdate ?? undefined,
      statusChanged: existing.status !== issue.status,
      assigneeChanged:
        existing.assigneeAgentId !== issue.assigneeAgentId ||
        existing.assigneeUserId !== issue.assigneeUserId,
      blockersChanged: Array.isArray(req.body.blockedByIssueIds),
      executionPolicyChanged: req.body.executionPolicy !== undefined,
      monitorChanged,
      resumeRequested: resumeRequested === true,
      reopened,
      blockedToTodoRecovery: statusChangedFromBlockedToTodo,
    });
    if (activeRecoveryActionBeforeUpdate && !revalidatedRecoveryAction) {
      issueResponse = {
        ...issueResponse,
        activeRecoveryAction: null,
      };
    }
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        ...updateFields,
        identifier: issue.identifier,
        ...(commentBody ? { source: "comment" } : {}),
        ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
        ...(scheduledRetrySupersededByComment
          ? {
              scheduledRetrySupersededByComment: true,
              scheduledRetryRunId: scheduledRetryForHumanComment?.runId ?? null,
              ...(cancelledScheduledRetryRunId ? { cancelledScheduledRetryRunId } : {}),
            }
          : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        ...(cancelledStatusRunId ? { cancelledStatusRunId } : {}),
        ...(workspaceChange ? { workspaceChange } : {}),
        _previous: hasFieldChanges ? previous : undefined,
        ...summarizeIssueReferenceActivityDetails(
          updateReferenceDiff
            ? {
                addedReferencedIssues: updateReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
                removedReferencedIssues: updateReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
                currentReferencedIssues: updateReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
              }
            : null,
        ),
      },
    });

    if (existing.status === "in_progress" && issue.status !== existing.status && issue.status !== "in_progress") {
      await listSuccessfulRunHandoffStates(db, issue.companyId, [issue.id])
        .then(async (handoffStates) => {
          const handoff = handoffStates.get(issue.id);
          if (handoff?.state !== "required") return;
          await logActivity(db, {
            companyId: issue.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.successful_run_handoff_resolved",
            entityType: "issue",
            entityId: issue.id,
            details: {
              identifier: issue.identifier,
              sourceRunId: handoff.sourceRunId,
              correctiveRunId: handoff.correctiveRunId,
              resolvedByStatus: issue.status,
            },
          });
        })
        .catch((err) => {
          logger.warn({ err, issueId: issue.id }, "failed to log successful run handoff resolution");
        });
    }

    if (Array.isArray(req.body.blockedByIssueIds)) {
      const previousBlockedByIds = new Set((existingRelations?.blockedBy ?? []).map((relation) => relation.id));
      const nextBlockedByIds = new Set(req.body.blockedByIssueIds as string[]);
      const addedBlockedByIssueIds = [...nextBlockedByIds].filter((candidate) => !previousBlockedByIds.has(candidate));
      const removedBlockedByIssueIds = [...previousBlockedByIds].filter((candidate) => !nextBlockedByIds.has(candidate));
      const nextBlockedByRelations = updatedRelations?.blockedBy ?? [];
      const previousBlockedByRelations = existingRelations?.blockedBy ?? [];
      if (addedBlockedByIssueIds.length > 0 || removedBlockedByIssueIds.length > 0) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.blockers_updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            blockedByIssueIds: req.body.blockedByIssueIds,
            addedBlockedByIssueIds,
            removedBlockedByIssueIds,
            blockedByIssues: nextBlockedByRelations.map(summarizeIssueRelationForActivity),
            addedBlockedByIssues: nextBlockedByRelations
              .filter((relation) => addedBlockedByIssueIds.includes(relation.id))
              .map(summarizeIssueRelationForActivity),
            removedBlockedByIssues: previousBlockedByRelations
              .filter((relation) => removedBlockedByIssueIds.includes(relation.id))
              .map(summarizeIssueRelationForActivity),
          },
        });
      }
    }

    const reviewerChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "review");
    if (reviewerChanges.addedParticipants.length > 0 || reviewerChanges.removedParticipants.length > 0) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.reviewers_updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          participants: reviewerChanges.participants,
          addedParticipants: reviewerChanges.addedParticipants,
          removedParticipants: reviewerChanges.removedParticipants,
        },
      });
    }

    const approverChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "approval");
    if (approverChanges.addedParticipants.length > 0 || approverChanges.removedParticipants.length > 0) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.approvers_updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          participants: approverChanges.participants,
          addedParticipants: approverChanges.addedParticipants,
          removedParticipants: approverChanges.removedParticipants,
        },
      });
    }

    const nextStoredExecutionPolicy = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
    const previousMonitor = summarizeIssueMonitor(existing, previousExecutionPolicy);
    const nextMonitor = summarizeIssueMonitor(issue, nextStoredExecutionPolicy);
    const monitorScheduledChanged = previousMonitor.nextCheckAt !== nextMonitor.nextCheckAt;
    if (nextMonitor.nextCheckAt && (monitorScheduledChanged || previousMonitor.notes !== nextMonitor.notes)) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.monitor_scheduled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          nextCheckAt: nextMonitor.nextCheckAt,
          previousNextCheckAt: previousMonitor.nextCheckAt,
          notes: nextMonitor.notes,
          scheduledBy: nextMonitor.scheduledBy,
          serviceName: nextMonitor.serviceName,
          timeoutAt: nextMonitor.timeoutAt,
          maxAttempts: nextMonitor.maxAttempts,
          recoveryPolicy: nextMonitor.recoveryPolicy,
        },
      });
    } else if (!nextMonitor.nextCheckAt && previousMonitor.nextCheckAt) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.monitor_cleared",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          previousNextCheckAt: previousMonitor.nextCheckAt,
          reason: nextMonitor.clearReason ?? "manual",
          notes: previousMonitor.notes,
        },
      });
    }

    if (issue.status === "done" && existing.status !== "done") {
      const tc = getTelemetryClient();
      if (tc && actor.agentId) {
        const actorAgent = await agentsSvc.getById(actor.agentId);
        if (actorAgent) {
          const model = typeof actorAgent.adapterConfig?.model === "string" ? actorAgent.adapterConfig.model : undefined;
          trackAgentTaskCompleted(tc, {
            agentRole: actorAgent.role,
            agentId: actorAgent.id,
            adapterType: actorAgent.adapterType,
            model,
          });
        }
      }
    }

    let comment = null;
    if (commentBody) {
      const commentReferenceSummaryBefore = updateReferenceSummaryAfter
        ?? await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      comment = await svc.addComment(id, commentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
      });
      await issueReferencesSvc.syncComment(comment.id);
      const commentReferenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const commentReferenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
        commentReferenceSummaryBefore,
        commentReferenceSummaryAfter,
      );
      issueResponse = {
        ...issueResponse,
        relatedWork: commentReferenceSummaryAfter,
        referencedIssueIdentifiers: commentReferenceSummaryAfter.outbound.map(
          (item) => item.issue.identifier ?? item.issue.id,
        ),
      };

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
          ...(scheduledRetrySupersededByComment
            ? {
                scheduledRetrySupersededByComment: true,
                scheduledRetryRunId: scheduledRetryForHumanComment?.runId ?? null,
                ...(cancelledScheduledRetryRunId ? { cancelledScheduledRetryRunId } : {}),
              }
            : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          ...(hasFieldChanges ? { updated: true } : {}),
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: commentReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: commentReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: commentReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      const expiredInteractions = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
        issue,
        comment,
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        issue,
        interactions: expiredInteractions,
        actor,
        source: "issue.comment",
      });

    } else if (updateReferenceSummaryAfter) {
      issueResponse = {
        ...issueResponse,
        relatedWork: updateReferenceSummaryAfter,
        referencedIssueIdentifiers: updateReferenceSummaryAfter.outbound.map(
          (item) => item.issue.identifier ?? item.issue.id,
        ),
      };
    }

    const assigneeChanged =
      issue.assigneeAgentId !== existing.assigneeAgentId || issue.assigneeUserId !== existing.assigneeUserId;
    const statusChangedFromBacklog =
      existing.status === "backlog" &&
      issue.status !== "backlog" &&
      req.body.status !== undefined;
    const statusChangedFromClosedToTodo =
      isClosedIssueStatus(existing.status) &&
      issue.status === "todo" &&
      req.body.status !== undefined;
    const previousExecutionState = parseIssueExecutionState(existing.executionState);
    const nextExecutionState = parseIssueExecutionState(issue.executionState);
    // GAP 3: carry the review-decision reason on the execution-stage wake so the
    // re-engaged agent's task prompt shows WHAT was requested.
    //  - changes_requested (implementer rework): the comment recorded on THIS
    //    PATCH IS the required change-request reason (commentBody is mandatory
    //    for a request-changes transition) — thread it directly, no extra read.
    //  - pending (reviewer re-review after a resubmit): surface the most recent
    //    change-request comment so the reviewer re-engages with the prior
    //    feedback in hand. The execution decision is stored in
    //    issueExecutionDecisions (not issueComments), but its body is mirrored
    //    into the change-request comment, so we locate that comment by matching
    //    the latest changes_requested decision body.
    let executionStageDecisionCommentId: string | null = null;
    if (nextExecutionState?.status === "changes_requested") {
      executionStageDecisionCommentId = transition.decision && comment ? comment.id : null;
    } else if (
      nextExecutionState?.status === "pending" &&
      nextExecutionState.currentStageType !== "approval" &&
      previousExecutionState?.status === "changes_requested"
    ) {
      try {
        const latestChangeRequest = await db
          .select({ body: issueExecutionDecisions.body })
          .from(issueExecutionDecisions)
          .where(
            and(
              eq(issueExecutionDecisions.issueId, issue.id),
              eq(issueExecutionDecisions.outcome, "changes_requested"),
            ),
          )
          .orderBy(desc(issueExecutionDecisions.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (latestChangeRequest?.body?.trim()) {
          const wanted = latestChangeRequest.body.trim();
          const recentComments = await svc.listComments(issue.id, { order: "desc", limit: 50 });
          const match = recentComments.find((c) => c.body?.trim() === wanted);
          executionStageDecisionCommentId = match?.id ?? null;
        }
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id },
          "failed to resolve prior change-request comment for re-review wake (best-effort)",
        );
      }
    }
    const executionStageWakeup = buildExecutionStageWakeup({
      issueId: issue.id,
      previousState: previousExecutionState,
      nextState: nextExecutionState,
      interruptedRunId,
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
      decisionCommentId: executionStageDecisionCommentId,
    });

    // Dual-brain on reassign (phase A — retired): see the create route. The
    // route-level dual_brain group auto-create caused route-only coverage and a
    // pair-engine-vs-QA execution collision (no execution lock). Self-review
    // moves to the heartbeat execution layer (phase B); no group is bound here.

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      type WakeupRequest = NonNullable<Parameters<typeof heartbeat.wakeup>[1]>;
      const wakeups = new Map<string, { agentId: string; wakeup: WakeupRequest }>();
      const addWakeup = (agentId: string, wakeup: WakeupRequest) => {
        const wakeIssueId =
          wakeup.payload && typeof wakeup.payload === "object" && typeof wakeup.payload.issueId === "string"
            ? wakeup.payload.issueId
            : issue.id;
        wakeups.set(`${agentId}:${wakeIssueId}`, { agentId, wakeup });
      };

      if (executionStageWakeup) {
        addWakeup(executionStageWakeup.agentId, executionStageWakeup.wakeup);
      } else if (assigneeChanged && issue.assigneeAgentId && issue.status !== "backlog") {
        addWakeup(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: {
            issueId: issue.id,
            ...(comment ? { commentId: comment.id } : {}),
            mutation: "update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            ...(comment
              ? {
                  taskId: issue.id,
                  commentId: comment.id,
                  wakeCommentId: comment.id,
                }
              : {}),
            source: "issue.update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (
        !assigneeChanged &&
        (statusChangedFromBacklog || statusChangedFromBlockedToTodo || statusChangedFromClosedToTodo) &&
        issue.assigneeAgentId
      ) {
        addWakeup(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_status_changed",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.status_change",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (commentBody && comment) {
        const assigneeId = issue.assigneeAgentId;
        const actorIsAgent = actor.actorType === "agent";
        const selfComment = actorIsAgent && actor.actorId === assigneeId;
        const skipAssigneeCommentWake = selfComment || isClosed;

        if (assigneeId && !assigneeChanged && (reopened || !skipAssigneeCommentWake)) {
          addWakeup(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: reopened ? "issue_reopened_via_comment" : "issue_commented",
            payload: {
              issueId: id,
              commentId: comment.id,
              mutation: "comment",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: reopened ? "issue.comment.reopen" : "issue.comment",
              wakeReason: reopened ? "issue_reopened_via_comment" : "issue_commented",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }

        let mentionedIds: string[] = [];
        try {
          mentionedIds = await svc.findMentionedAgents(issue.companyId, commentBody);
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }

        for (const mentionedId of mentionedIds) {
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          addWakeup(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
            },
          });
        }
      }

      const becameDone = existing.status !== "done" && issue.status === "done";
      if (becameDone) {
        const dependents = await svc.listWakeableBlockedDependents(issue.id);
        for (const dependent of dependents) {
          addWakeup(dependent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_blockers_resolved",
            payload: {
              issueId: dependent.id,
              resolvedBlockerIssueId: issue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: dependent.id,
              taskId: dependent.id,
              wakeReason: "issue_blockers_resolved",
              source: "issue.blockers_resolved",
              resolvedBlockerIssueId: issue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
          });
        }
      }

      const becameTerminal =
        !["done", "cancelled"].includes(existing.status) && ["done", "cancelled"].includes(issue.status);
      if (becameTerminal && issue.parentId) {
        const parent = await svc.getWakeableParentAfterChildCompletion(issue.parentId);
        if (parent) {
          addWakeup(parent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_children_completed",
            payload: {
              issueId: parent.id,
              completedChildIssueId: issue.id,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: parent.id,
              taskId: parent.id,
              wakeReason: "issue_children_completed",
              source: "issue.children_completed",
              completedChildIssueId: issue.id,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
          });
        }
      }

      for (const { agentId, wakeup } of wakeups.values()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();

    res.json({ ...issueResponse, comment });
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    res.json(issue);
  });

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (issue.projectId) {
      const project = await projectsSvc.getById(issue.projectId);
      if (project?.pausedAt) {
        res.status(409).json({
          error:
            project.pauseReason === "budget"
              ? "Project is paused because its budget hard-stop was reached"
              : "Project is paused",
        });
        return;
      }
    }

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    if (issue.assigneeAgentId !== req.body.agentId) {
      await assertCanAssignTasks(req, issue.companyId, {
        issueId: issue.id,
        projectId: issue.projectId ?? null,
        parentIssueId: issue.parentId ?? null,
        assigneeAgentId: req.body.agentId,
        assigneeUserId: null,
      });
    }

    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: req.body.agentId },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        actorType: req.actor.type,
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    res.json(updated);
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    const actorRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !actorRunId) return;

    const released = await svc.release(
      id,
      req.actor.type === "agent" ? req.actor.agentId : undefined,
      actorRunId,
    );
    if (!released) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    res.json(released);
  });

  router.post("/issues/:id/admin/force-release", async (req, res) => {
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board access required" });
      return;
    }
    if (!req.actor.userId) {
      throw forbidden("Board user context required");
    }

    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const clearAssignee = req.query.clearAssignee === "true";
    const result = await svc.adminForceRelease(id, { clearAssignee });
    if (!result) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.admin_force_release",
      entityType: "issue",
      entityId: result.issue.id,
      details: {
        issueId: result.issue.id,
        actorUserId: req.actor.userId,
        prevCheckoutRunId: result.previous.checkoutRunId,
        prevExecutionRunId: result.previous.executionRunId,
        clearAssignee,
      },
    });

    res.json(result);
  });

  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const afterCommentId =
      typeof req.query.after === "string" && req.query.after.trim().length > 0
        ? req.query.after.trim()
        : typeof req.query.afterCommentId === "string" && req.query.afterCommentId.trim().length > 0
          ? req.query.afterCommentId.trim()
          : null;
    const order =
      typeof req.query.order === "string" && req.query.order.trim().toLowerCase() === "asc"
        ? "asc"
        : "desc";
    const limitRaw =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : null;
    const limit =
      limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_ISSUE_COMMENT_LIMIT)
        : null;
    const comments = await svc.listComments(id, {
      afterCommentId,
      order,
      limit,
    });
    res.json(comments);
  });

  router.get("/issues/:id/interactions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const interactionSvc = issueThreadInteractionService(db);
    const expiredInteractions = await interactionSvc.expireRequestConfirmationsSupersededByHistoricalComments(issue);
    await logExpiredRequestConfirmations({
      issue,
      interactions: expiredInteractions,
      actor,
      source: "issue.interactions.catchup_superseded_by_comment",
    });

    const interactions = await interactionSvc.listForIssue(id);
    res.json(interactions);
  });

  router.post("/issues/:id/interactions", validate(createIssueThreadInteractionSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type === "agent") {
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    } else {
      assertBoard(req);
    }

    const actor = getActorInfo(req);
    const agentSourceRunId = req.actor.type === "agent" ? requireAgentRunId(req, res) : null;
    if (req.actor.type === "agent" && !agentSourceRunId) return;

    let interaction = await issueThreadInteractionService(db).create(issue, {
      ...req.body,
      sourceRunId: req.actor.type === "agent" ? agentSourceRunId : req.body.sourceRunId ?? null,
    }, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    // WC-176: Autonomous (unattended) mode also covers request_confirmation.
    // A request_confirmation is a user-participation gate — the agent is asking a
    // human to confirm its output before continuing — and it is the mechanism real
    // agents actually use for user review (executionPolicy user-stages, which the
    // WC-168 skip targets, are a separate path). When auto-approval applies, auto-
    // accept it as the system so the workflow runs to completion without a person
    // in the loop, then re-wake the creator agent to continue (mirrors the /accept
    // route's continuation handling). Only a user-only gate is skipped; agent work
    // continues normally.
    //
    // Team autonomy: the primary switch is the company-level
    // autoApproveConfirmations setting (explicit, board-visible). The instance
    // EXPERIMENTAL autonomousMode flag is kept as a back-compat GLOBAL override —
    // it predates the team setting and still force-enables auto-accept across
    // every company when on.
    let confirmationAutoApproveSource: "team_autonomy" | "instance_experimental" | null = null;
    if (interaction.kind === "request_confirmation" && interaction.status === "pending") {
      const interactionCompany = await companiesSvc.getById(issue.companyId);
      if (interactionCompany?.autoApproveConfirmations === true) {
        confirmationAutoApproveSource = "team_autonomy";
      } else if ((await instanceSettings.getExperimental()).autonomousMode) {
        confirmationAutoApproveSource = "instance_experimental";
      }
      if (confirmationAutoApproveSource) {
        const accepted = await issueThreadInteractionService(db).acceptInteraction(
          issue,
          interaction.id,
          {},
          { agentId: null, userId: "system" },
        );
        interaction = accepted.interaction;
        if (interaction.status === "accepted") {
          const continuationWakeIssue = accepted.continuationIssue ?? issue;
          const acceptedPlanConfirmation = issue.workMode === "planning";
          queueResolvedInteractionContinuationWakeup({
            heartbeat,
            issue: continuationWakeIssue,
            interaction,
            actor: { actorType: "user", actorId: "system" },
            source: "issue.interaction.autonomous_auto_accept",
            forceFreshSession: acceptedPlanConfirmation,
            workspaceRefreshReason: acceptedPlanConfirmation ? "accepted_plan_confirmation" : null,
          });
        }
      }
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        continuationPolicy: interaction.continuationPolicy,
        // Auto-approval audit trail: when the system auto-accepted this
        // request_confirmation, record that it happened and WHY (team setting
        // vs. the back-compat instance experimental flag) so the UI can
        // distinguish "board approved" from "autonomy approved".
        ...(confirmationAutoApproveSource && interaction.status === "accepted"
          ? { autoApproved: true, autoApproveSource: confirmationAutoApproveSource }
          : {}),
      },
    });

    res.status(201).json(interaction);
  });

  router.post(
    "/issues/:id/interactions/:interactionId/accept",
    validate(acceptIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const { interaction, createdIssues, continuationIssue } = await issueThreadInteractionService(db).acceptInteraction(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
      const continuationWakeIssue = continuationIssue ?? issue;

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_accepted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          createdTaskCount:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.createdTasks?.length ?? 0)
              : 0,
          skippedTaskCount:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.skippedClientKeys?.length ?? 0)
              : 0,
        },
      });

      if (continuationIssue) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            status: continuationIssue.status,
            assigneeAgentId: continuationIssue.assigneeAgentId ?? null,
            assigneeUserId: continuationIssue.assigneeUserId ?? null,
            source: "request_confirmation_accept",
            interactionId: interaction.id,
            _previous: {
              status: issue.status,
              assigneeAgentId: issue.assigneeAgentId ?? null,
              assigneeUserId: issue.assigneeUserId ?? null,
            },
          },
        });
      }

      for (const createdIssue of createdIssues) {
        void queueIssueAssignmentWakeup({
          heartbeat,
          issue: createdIssue,
          reason: "issue_assigned",
          mutation: "interaction_accept",
          contextSource: "issue.interaction.accept",
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
        });
      }

      const acceptedPlanConfirmation =
        interaction.kind === "request_confirmation" &&
        interaction.status === "accepted" &&
        issue.workMode === "planning";
      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue: continuationWakeIssue,
        interaction,
        actor,
        source: "issue.interaction.accept",
        forceFreshSession: acceptedPlanConfirmation,
        workspaceRefreshReason: acceptedPlanConfirmation ? "accepted_plan_confirmation" : null,
      });

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/reject",
    validate(rejectIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await issueThreadInteractionService(db).rejectInteraction(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_rejected",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          rejectionReason:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.rejectionReason ?? null)
              : interaction.kind === "request_confirmation"
                ? (interaction.result?.reason ?? null)
              : null,
        },
      });

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.reject",
      });

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/respond",
    validate(respondIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await issueThreadInteractionService(db).answerQuestions(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.thread_interaction_answered",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          answeredQuestionCount:
            interaction.kind === "ask_user_questions"
              ? (interaction.result?.answers?.length ?? 0)
              : 0,
        },
      });

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.respond",
      });

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/cancel",
    validate(cancelIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await issueThreadInteractionService(db).cancelQuestions(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.thread_interaction_cancelled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          cancellationReason:
            interaction.kind === "ask_user_questions"
              ? (interaction.result?.cancellationReason ?? null)
              : null,
        },
      });

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.cancel",
      });

      res.json(interaction);
    },
  );

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.delete("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;

    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    const actor = getActorInfo(req);
    const actorOwnsComment =
      actor.actorType === "agent"
        ? comment.authorAgentId === actor.agentId
        : comment.authorUserId === actor.actorId;
    if (!actorOwnsComment) {
      res.status(403).json({ error: "Only the comment author can cancel queued comments" });
      return;
    }

    const activeRun = await resolveActiveIssueRun(issue);
    if (!activeRun) {
      res.status(409).json({ error: "Queued comment can no longer be canceled" });
      return;
    }

    if (!isQueuedIssueCommentForActiveRun({ comment, activeRun })) {
      res.status(409).json({ error: "Only queued comments can be canceled" });
      return;
    }

    const removed = await svc.removeComment(commentId);
    if (!removed) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_cancelled",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId: removed.id,
        bodySnippet: removed.body.slice(0, 120),
        identifier: issue.identifier,
        issueTitle: issue.title,
        source: "queue_cancel",
        queueTargetRunId: activeRun.id,
      },
    });

    res.json(removed);
  });

  router.get("/issues/:id/feedback-votes", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback votes" });
      return;
    }

    const votes = await feedback.listIssueVotesForUser(id, req.actor.userId ?? "local-board");
    res.json(votes);
  });

  router.get("/issues/:id/feedback-traces", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const targetType = targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined;
    const vote = voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined;
    const status = statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId: issue.companyId,
      issueId: issue.id,
      targetType,
      vote,
      status,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.get("/feedback-traces/:traceId", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }
    const includePayload = parseBooleanQuery(req.query.includePayload) || req.query.includePayload === undefined;
    const trace = await feedback.getFeedbackTraceById(traceId, includePayload);
    if (!trace || !actorCanAccessCompany(req, trace.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(trace);
  });

  router.get("/feedback-traces/:traceId/bundle", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback trace bundles" });
      return;
    }
    const bundle = await feedback.getFeedbackTraceBundle(traceId);
    if (!bundle || !actorCanAccessCompany(req, bundle.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(bundle);
  });

  router.post("/issues/:id/comments", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!assertStructuredCommentFieldsAllowed(req, res, {
      presentation: req.body.presentation,
      metadata: req.body.metadata,
    })) return;
    const commentMojibake = buildMojibakeRejection({ body: req.body.body });
    if (commentMojibake) {
      res.status(400).json(commentMojibake);
      return;
    }
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const actor = getActorInfo(req);
    const reopenRequested = req.body.reopen === true;
    const resumeRequested = req.body.resume === true;
    const interruptRequested = req.body.interrupt === true;
    if (resumeRequested === true && !(await assertExplicitResumeIntentAllowed(req, res, issue))) return;
    if (resumeRequested !== true && reopenRequested === true && req.actor.type === "agent") {
      if (!(await assertExplicitResumeIntentAllowed(req, res, issue))) return;
    }
    const isClosed = isClosedIssueStatus(issue.status);
    const isBlocked = issue.status === "blocked";
    const explicitMoveToTodoRequested = reopenRequested || resumeRequested === true;
    const scheduledRetryForHumanComment =
      shouldHumanCommentResumeInProgressScheduledRetry({
        hasComment: true,
        issueStatus: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        actorType: actor.actorType,
      })
        ? await svc.getCurrentScheduledRetry(issue.id)
        : null;
    const shouldResumeInProgressScheduledRetry =
      !!scheduledRetryForHumanComment &&
      scheduledRetryForHumanComment.agentId === issue.assigneeAgentId;
    const effectiveMoveToTodoRequested =
      explicitMoveToTodoRequested ||
      shouldImplicitlyMoveCommentedIssueToTodo({
        issueStatus: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        actorType: actor.actorType,
        actorId: actor.actorId,
      }) ||
      shouldResumeInProgressScheduledRetry;
    const hasUnresolvedFirstClassBlockers =
      isBlocked && effectiveMoveToTodoRequested
        ? (await svc.getDependencyReadiness(issue.id)).unresolvedBlockerCount > 0
        : false;
    if (resumeRequested === true && isBlocked && hasUnresolvedFirstClassBlockers) {
      res.status(409).json({ error: "Issue follow-up blocked by unresolved blockers" });
      return;
    }
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;
    const commentReferenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);

    let scheduledRetrySupersededByComment = false;
    let cancelledScheduledRetryRunId: string | null = null;
    if (
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers) || shouldResumeInProgressScheduledRetry)
    ) {
      scheduledRetrySupersededByComment = shouldResumeInProgressScheduledRetry && issue.status === "in_progress";
      cancelledScheduledRetryRunId = scheduledRetrySupersededByComment
        ? await cancelScheduledRetrySupersededByComment({
            scheduledRetryRunId: scheduledRetryForHumanComment?.runId,
            issue,
            actor,
          })
        : null;
      const reopenedIssue = await svc.update(id, { status: "todo" });
      if (!reopenedIssue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      reopened = isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers);
      reopenFromStatus = reopened ? issue.status : null;
      currentIssue = reopenedIssue;

      await logActivity(db, {
        companyId: currentIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          status: "todo",
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
          ...(scheduledRetrySupersededByComment
            ? {
                scheduledRetrySupersededByComment: true,
                scheduledRetryRunId: scheduledRetryForHumanComment?.runId ?? null,
                ...(cancelledScheduledRetryRunId ? { cancelledScheduledRetryRunId } : {}),
              }
            : {}),
          source: "comment",
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          identifier: currentIssue.identifier,
        },
      });
    }

    if (interruptRequested) {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(currentIssue);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: currentIssue.id },
          });
        }
      }
    }

    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
      runId: actor.runId,
    }, {
      authorType: req.body.authorType ?? (actor.actorType === "agent" ? "agent" : "user"),
      presentation: req.body.presentation ?? null,
      metadata: req.body.metadata ?? null,
    });
    await issueReferencesSvc.syncComment(comment.id);
    const commentReferenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(currentIssue.id);
    const commentReferenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
      commentReferenceSummaryBefore,
      commentReferenceSummaryAfter,
    );

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue comment"));
    }

    await logActivity(db, {
      companyId: currentIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(scheduledRetrySupersededByComment
          ? {
              scheduledRetrySupersededByComment: true,
              scheduledRetryRunId: scheduledRetryForHumanComment?.runId ?? null,
              ...(cancelledScheduledRetryRunId ? { cancelledScheduledRetryRunId } : {}),
            }
          : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: commentReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: commentReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: commentReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    const expiredInteractions = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
      currentIssue,
      comment,
      {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    );
    await logExpiredRequestConfirmations({
      issue: currentIssue,
      interactions: expiredInteractions,
      actor,
      source: "issue.comment",
    });

    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue: currentIssue,
      trigger: "comment",
      actor,
      statusChanged: reopened || scheduledRetrySupersededByComment,
      resumeRequested: resumeRequested === true,
      reopened,
      blockedToTodoRecovery: reopened && reopenFromStatus === "blocked" && currentIssue.status === "todo",
    });

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const skipWake = selfComment || isClosed;
      if (assigneeId && (reopened || !skipWake)) {
        if (reopened) {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_reopened_via_comment",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment.reopen",
              wakeReason: "issue_reopened_via_comment",
              reopenedFrom: reopenFromStatus,
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              mutation: "comment",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment",
              wakeReason: "issue_commented",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      let mentionedIds: string[] = [];
      try {
        mentionedIds = await svc.findMentionedAgents(issue.companyId, req.body.body);
      } catch (err) {
        logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
      }

      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        wakeups.set(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: id,
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_comment_mentioned",
            source: "comment.mention",
          },
        });
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    res.status(201).json(comment);
  });

  router.post("/issues/:id/feedback-votes", validate(upsertIssueFeedbackVoteSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can vote on AI feedback" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await feedback.saveIssueVote({
      issueId: id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      vote: req.body.vote,
      reason: req.body.reason,
      authorUserId: req.actor.userId ?? "local-board",
      allowSharing: req.body.allowSharing === true,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.feedback_vote_saved",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        targetType: result.vote.targetType,
        targetId: result.vote.targetId,
        vote: result.vote.vote,
        hasReason: Boolean(result.vote.reason),
        sharingEnabled: result.sharingEnabled,
      },
    });

    if (result.consentEnabledNow) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.feedback_data_sharing_updated",
        entityType: "company",
        entityId: issue.companyId,
        details: {
          feedbackDataSharingEnabled: true,
          source: "issue_feedback_vote",
        },
      });
    }

    if (result.persistedSharingPreference) {
      const settings = await instanceSettings.get();
      const companyIds = await instanceSettings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: settings.id,
            details: {
              general: settings.general,
              changedKeys: ["feedbackDataSharingPreference"],
              source: "issue_feedback_vote",
            },
          }),
        ),
      );
    }

    if (result.sharingEnabled && result.traceId && feedbackExportService) {
      try {
        await feedbackExportService.flushPendingFeedbackTraces({
          companyId: issue.companyId,
          traceId: result.traceId,
          limit: 1,
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, traceId: result.traceId }, "failed to flush shared feedback trace immediately");
      }
    }

    res.status(201).json(result.vote);
  });

  router.get("/issues/:id/attachments", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const attachments = await svc.listAttachments(issueId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/issues/:issueId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;

    const company = await companiesSvc.getById(companyId);
    const attachmentMaxBytes = normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes);

    try {
      await runSingleFileUpload(req, res, attachmentMaxBytes);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${attachmentMaxBytes} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = normalizeContentType(file.mimetype);
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_added",
      entityType: "issue",
      entityId: issueId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);

    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    const responseContentType = normalizeContentType(attachment.contentType || object.contentType);
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === SVG_CONTENT_TYPE) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = attachment.originalFilename ?? "attachment";
    const disposition = isInlineAttachmentContentType(responseContentType) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
