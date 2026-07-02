import { z } from "zod";
import {
  addIssueCommentSchema,
  askUserQuestionsPayloadSchema,
  checkoutIssueSchema,
  createApprovalSchema,
  createIssueInputSchema,
  issueThreadInteractionContinuationPolicySchema,
  requestConfirmationPayloadSchema,
  suggestTasksPayloadSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
  linkIssueApprovalSchema,
} from "@workcell/shared";
import { WorkcellApiClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

function parseOptionalJson(raw: string | undefined | null): unknown {
  if (!raw || raw.trim().length === 0) return undefined;
  return JSON.parse(raw);
}

const companyIdOptional = z.string().uuid().optional().nullable();
const agentIdOptional = z.string().uuid().optional().nullable();
const issueIdSchema = z.string().min(1);
const projectIdSchema = z.string().min(1);
const goalIdSchema = z.string().uuid();
const approvalIdSchema = z.string().uuid();
const documentKeySchema = z.string().trim().min(1).max(64);

const listIssuesSchema = z.object({
  companyId: companyIdOptional,
  status: z.string().optional(),
  projectId: z.string().uuid().optional(),
  assigneeAgentId: z.string().uuid().optional(),
  participantAgentId: z.string().uuid().optional(),
  assigneeUserId: z.string().optional(),
  touchedByUserId: z.string().optional(),
  inboxArchivedByUserId: z.string().optional(),
  unreadForUserId: z.string().optional(),
  labelId: z.string().uuid().optional(),
  executionWorkspaceId: z.string().uuid().optional(),
  originKind: z.string().optional(),
  originId: z.string().optional(),
  includeRoutineExecutions: z.boolean().optional(),
  q: z.string().optional(),
});

const listCommentsSchema = z.object({
  issueId: issueIdSchema,
  after: z.string().uuid().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const upsertDocumentToolSchema = z.object({
  issueId: issueIdSchema,
  key: documentKeySchema,
  title: z.string().trim().max(200).nullable().optional(),
  format: z.enum(["markdown"]).default("markdown"),
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

const createIssueToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createIssueInputSchema);

const updateIssueToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(updateIssueSchema);

const checkoutIssueToolSchema = z.object({
  issueId: issueIdSchema,
  agentId: agentIdOptional,
  expectedStatuses: checkoutIssueSchema.shape.expectedStatuses.optional(),
});

const addCommentToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(addIssueCommentSchema);

const createSuggestTasksToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: suggestTasksPayloadSchema,
});

const createAskUserQuestionsToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: askUserQuestionsPayloadSchema,
});

const createRequestConfirmationToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("none"),
  payload: requestConfirmationPayloadSchema,
});

const approvalDecisionSchema = z.object({
  approvalId: approvalIdSchema,
  action: z.enum(["approve", "reject", "requestRevision", "resubmit"]),
  decisionNote: z.string().optional(),
  payloadJson: z.string().optional(),
});

const createApprovalToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createApprovalSchema);

const apiRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  jsonBody: z.string().optional(),
});

const workspaceRuntimeControlTargetSchema = z.object({
  workspaceCommandId: z.string().min(1).optional().nullable(),
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceIndex: z.number().int().nonnegative().optional().nullable(),
});

const issueWorkspaceRuntimeControlSchema = z.object({
  issueId: issueIdSchema,
  action: z.enum(["start", "stop", "restart"]),
}).merge(workspaceRuntimeControlTargetSchema);

const waitForIssueWorkspaceServiceSchema = z.object({
  issueId: issueIdSchema,
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceName: z.string().min(1).optional().nullable(),
  timeoutSeconds: z.number().int().positive().max(300).optional(),
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCurrentExecutionWorkspace(context: unknown): Record<string, unknown> | null {
  if (!context || typeof context !== "object") return null;
  const workspace = (context as { currentExecutionWorkspace?: unknown }).currentExecutionWorkspace;
  return workspace && typeof workspace === "object" ? workspace as Record<string, unknown> : null;
}

function readWorkspaceRuntimeServices(workspace: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const raw = workspace?.runtimeServices;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

function selectRuntimeService(
  services: Array<Record<string, unknown>>,
  input: { runtimeServiceId?: string | null; serviceName?: string | null },
) {
  if (input.runtimeServiceId) {
    return services.find((service) => service.id === input.runtimeServiceId) ?? null;
  }
  if (input.serviceName) {
    return services.find((service) => service.serviceName === input.serviceName) ?? null;
  }
  return services.find((service) => service.status === "running" || service.status === "starting")
    ?? services[0]
    ?? null;
}

async function getIssueWorkspaceRuntime(client: WorkcellApiClient, issueId: string) {
  const context = await client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context`);
  const workspace = readCurrentExecutionWorkspace(context);
  return {
    context,
    workspace,
    runtimeServices: readWorkspaceRuntimeServices(workspace),
  };
}

// WC-181 (slice 4): per-agent memory self-management over the inbound MCP
// surface. These mirror the WC-62 Knowledge Graph tools above — they call the
// slice-2 REST routes (/agents/{id}/memory…) with the CALLING agent's own id,
// which the route hard-scopes (403 on any other :agentId). The agent's id +
// company + run come from the client config (its own credentials), never from
// tool input — an agent can only ever read/write/forget its OWN memory.
const MEMORY_NODE_KIND_VALUES = [
  "fact",
  "preference",
  "entity",
  "decision",
  "todo",
  "other",
] as const;
const memoryKindSchema = z.enum(MEMORY_NODE_KIND_VALUES);

const memoryRememberSchema = z.object({
  kind: memoryKindSchema,
  label: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(8192),
  metadata: z.record(z.unknown()).optional(),
});

// Forget by node id OR by identity (kind+label). The route only deletes by id,
// so an identity forget resolves the id from the agent's own graph first.
// Kept as a plain ZodObject (not a refine/ZodEffects) so the MCP server can read
// `.shape` when registering the tool; the "must identify something" check lives
// in the executor below.
const memoryForgetSchema = z.object({
  nodeId: z.string().uuid().optional(),
  kind: memoryKindSchema.optional(),
  label: z.string().trim().min(1).max(200).optional(),
});

const memoryRecallSchema = z.object({
  kind: memoryKindSchema.optional(),
});

const memoryLinkSchema = z.object({
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  relation: z.string().trim().min(1).max(120),
  metadata: z.record(z.unknown()).optional(),
});

// WC-182g (D22): designer-agent design-attach + design-review-submit tools.
// These close the designer leg of the 5-agent loop: during a run on a UI/design
// issue the designer agent GENERATES a self-contained HTML mockup (the 시안),
// attaches it as the issue's source-of-truth design via POST
// /issues/:id/design-artifacts, then opens the board's design-review gate via
// POST /work-products/:id/design-review/submit. The design-type set mirrors the
// shared DESIGN_WORK_PRODUCT_TYPES (see @workcell/shared); we inline the literal
// list here to keep the MCP package's dependency surface unchanged. Identity is
// always the calling agent's own (the client carries it on the write), exactly
// like the other write tools — agentId is never taken from tool input.
const DESIGN_WORK_PRODUCT_TYPE_VALUES = [
  "design",
  "ui_preview",
  "mockup",
  "screenshot",
  "figma_frame",
] as const;
const designTypeSchema = z.enum(DESIGN_WORK_PRODUCT_TYPE_VALUES);

const designAttachLinkSchema = z.object({
  label: z.string().trim().max(120).optional(),
  targetScreenKey: z.string().trim().min(1).max(200),
});

const designAttachSchema = z
  .object({
    issueId: issueIdSchema,
    title: z.string().trim().min(1).max(200),
    html: z.string().min(1).optional(),
    url: z.string().url().optional(),
    type: designTypeSchema.default("design"),
    summary: z.string().trim().max(2000).optional(),
    // Design-system redesign: ONE screen per design_attach. screenKey is a stable
    // slug for this app page (derived from screenName if omitted); screenName its
    // display label. links declares where elements on THIS screen navigate to.
    screenKey: z.string().trim().min(1).max(200).optional(),
    screenName: z.string().trim().min(1).max(200).optional(),
    links: z.array(designAttachLinkSchema).optional(),
    planMarkdown: z.string().max(50_000).optional(),
    formFactor: z.enum(["mobile", "tablet", "desktop"]).optional(),
    makeAuthoritative: z.boolean().default(true),
  });

const designSubmitForReviewSchema = z.object({
  workProductId: z.string().uuid(),
});

// Build a self-contained preview data URL from raw HTML. The `charset=utf-8` is
// REQUIRED: without it Korean / non-ASCII 시안 content renders as mojibake when
// the board opens the preview. encodeURIComponent keeps the payload a valid URL.
// Kept as the upload-failure fallback for attachSianHtml.
function htmlToDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// Persist agent-authored 시안 (mockup) HTML as a SHORT asset URL
// (/api/assets/<id>/content) rather than inlining the entire document as a giant
// data:text/html URL. The data-URL form embeds the whole mockup into the work
// product `url`, which then floods run logs and downstream agent prompts (the
// "Parent work product: url=data:text/html,…<thousands of chars>" problem). The
// asset is uploaded to the agent's OWN company via the existing images endpoint
// (text/html is an allowed type; the asset GET route serves it under a strict
// `sandbox` CSP). On ANY failure — no company id, network, server rejection — we
// fall back to the legacy data: URL so attaching a design never breaks.
async function attachSianHtml(client: WorkcellApiClient, html: string): Promise<string> {
  try {
    const companyId = client.resolveCompanyId();
    const form = new FormData();
    form.append("namespace", "design-sian");
    form.append("file", new Blob([html], { type: "text/html" }), "sian.html");
    const upload = await client.uploadMultipart<{ contentPath?: string }>(
      `/companies/${encodeURIComponent(companyId)}/assets/images`,
      form,
    );
    if (upload?.contentPath) {
      return client.absoluteAssetUrl(upload.contentPath);
    }
  } catch (err) {
    // stderr is safe for MCP servers (stdout carries the protocol). Surface the
    // reason so a misconfigured upload path is debuggable, then degrade.
    console.warn(
      `[workcell] design_attach: 시안 asset upload failed, falling back to inline data URL: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return htmlToDataUrl(html);
}

interface MemoryGraphNode {
  id: string;
  kind: string;
  label: string;
  content?: string;
}

interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: Array<Record<string, unknown>>;
}

async function recallMemoryGraph(client: WorkcellApiClient): Promise<MemoryGraph> {
  const agentId = client.resolveAgentId();
  const graph = await client.requestJson<MemoryGraph>(
    "GET",
    `/agents/${encodeURIComponent(agentId)}/memory`,
  );
  return {
    nodes: Array.isArray(graph?.nodes) ? graph.nodes : [],
    edges: Array.isArray(graph?.edges) ? graph.edges : [],
  };
}

export function createToolDefinitions(client: WorkcellApiClient): ToolDefinition[] {
  return [
    makeTool(
      "workcellMe",
      "Get the current authenticated Workcell actor details",
      z.object({}),
      async () => client.requestJson("GET", "/agents/me"),
    ),
    makeTool(
      "workcellInboxLite",
      "Get the current authenticated agent inbox-lite assignment list",
      z.object({}),
      async () => client.requestJson("GET", "/agents/me/inbox-lite"),
    ),
    makeTool(
      "workcellListAgents",
      "List agents in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/agents`),
    ),
    makeTool(
      "workcellGetAgent",
      "Get a single agent by id",
      z.object({ agentId: z.string().min(1), companyId: companyIdOptional }),
      async ({ agentId, companyId }) => {
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("GET", `/agents/${encodeURIComponent(agentId)}${qs}`);
      },
    ),
    makeTool(
      "workcellListIssues",
      "List issues for a company with optional filters",
      listIssuesSchema,
      async (input) => {
        const companyId = client.resolveCompanyId(input.companyId);
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(input)) {
          if (key === "companyId" || value === undefined || value === null) continue;
          params.set(key, String(value));
        }
        const qs = params.toString();
        return client.requestJson("GET", `/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
      },
    ),
    makeTool(
      "workcellGetIssue",
      "Get a single issue by UUID or identifier",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}`),
    ),
    makeTool(
      "workcellGetHeartbeatContext",
      "Get compact heartbeat context for an issue",
      z.object({ issueId: issueIdSchema, wakeCommentId: z.string().uuid().optional() }),
      async ({ issueId, wakeCommentId }) => {
        const qs = wakeCommentId ? `?wakeCommentId=${encodeURIComponent(wakeCommentId)}` : "";
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context${qs}`);
      },
    ),
    makeTool(
      "workcellListComments",
      "List issue comments with incremental options",
      listCommentsSchema,
      async ({ issueId, after, order, limit }) => {
        const params = new URLSearchParams();
        if (after) params.set("after", after);
        if (order) params.set("order", order);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments${qs ? `?${qs}` : ""}`);
      },
    ),
    makeTool(
      "workcellGetComment",
      "Get a specific issue comment by id",
      z.object({ issueId: issueIdSchema, commentId: z.string().uuid() }),
      async ({ issueId, commentId }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`),
    ),
    makeTool(
      "workcellListIssueApprovals",
      "List approvals linked to an issue",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/approvals`),
    ),
    makeTool(
      "workcellListDocuments",
      "List issue documents",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents`),
    ),
    makeTool(
      "workcellGetDocument",
      "Get one issue document by key",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`),
    ),
    makeTool(
      "workcellListDocumentRevisions",
      "List revisions for an issue document",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson(
          "GET",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions`,
        ),
    ),
    makeTool(
      "workcellListProjects",
      "List projects in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/projects`),
    ),
    makeTool(
      "workcellGetProject",
      "Get a project by id or company-scoped short reference",
      z.object({ projectId: projectIdSchema, companyId: companyIdOptional }),
      async ({ projectId, companyId }) => {
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("GET", `/projects/${encodeURIComponent(projectId)}${qs}`);
      },
    ),
    makeTool(
      "workcellGetIssueWorkspaceRuntime",
      "Get the current execution workspace and runtime services for an issue, including service URLs",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => getIssueWorkspaceRuntime(client, issueId),
    ),
    makeTool(
      "workcellControlIssueWorkspaceServices",
      "Start, stop, or restart the current issue execution workspace runtime services",
      issueWorkspaceRuntimeControlSchema,
      async ({ issueId, action, ...target }) => {
        const runtime = await getIssueWorkspaceRuntime(client, issueId);
        const workspaceId = typeof runtime.workspace?.id === "string" ? runtime.workspace.id : null;
        if (!workspaceId) {
          throw new Error("Issue has no current execution workspace");
        }
        return client.requestJson(
          "POST",
          `/execution-workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`,
          { body: target },
        );
      },
    ),
    makeTool(
      "workcellWaitForIssueWorkspaceService",
      "Wait until an issue execution workspace runtime service is running and has a URL when one is exposed",
      waitForIssueWorkspaceServiceSchema,
      async ({ issueId, runtimeServiceId, serviceName, timeoutSeconds }) => {
        const deadline = Date.now() + (timeoutSeconds ?? 60) * 1000;
        let latest: Awaited<ReturnType<typeof getIssueWorkspaceRuntime>> | null = null;
        while (Date.now() <= deadline) {
          latest = await getIssueWorkspaceRuntime(client, issueId);
          const service = selectRuntimeService(latest.runtimeServices, { runtimeServiceId, serviceName });
          if (service?.status === "running" && service.healthStatus !== "unhealthy") {
            return {
              workspace: latest.workspace,
              service,
            };
          }
          await sleep(1000);
        }

        return {
          timedOut: true,
          latestWorkspace: latest?.workspace ?? null,
          latestRuntimeServices: latest?.runtimeServices ?? [],
        };
      },
    ),
    makeTool(
      "workcellListGoals",
      "List goals in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/goals`),
    ),
    makeTool(
      "workcellGetGoal",
      "Get a goal by id",
      z.object({ goalId: goalIdSchema }),
      async ({ goalId }) => client.requestJson("GET", `/goals/${encodeURIComponent(goalId)}`),
    ),
    makeTool(
      "workcellListApprovals",
      "List approvals in a company",
      z.object({ companyId: companyIdOptional, status: z.string().optional() }),
      async ({ companyId, status }) => {
        const qs = status ? `?status=${encodeURIComponent(status)}` : "";
        return client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/approvals${qs}`);
      },
    ),
    makeTool(
      "workcellCreateApproval",
      "Create a board approval request, optionally linked to one or more issues",
      createApprovalToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/approvals`, {
          body,
        }),
    ),
    makeTool(
      "workcellGetApproval",
      "Get an approval by id",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}`),
    ),
    makeTool(
      "workcellGetApprovalIssues",
      "List issues linked to an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/issues`),
    ),
    makeTool(
      "workcellListApprovalComments",
      "List comments for an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/comments`),
    ),
    makeTool(
      "workcellCreateIssue",
      "Create a new issue",
      createIssueToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/issues`, { body }),
    ),
    makeTool(
      "workcellUpdateIssue",
      "Patch an issue, optionally including a comment; include resume=true when intentionally requesting follow-up on resumable closed work",
      updateIssueToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("PATCH", `/issues/${encodeURIComponent(issueId)}`, { body }),
    ),
    makeTool(
      "workcellCheckoutIssue",
      "Checkout an issue for an agent",
      checkoutIssueToolSchema,
      async ({ issueId, agentId, expectedStatuses }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/checkout`, {
          body: {
            agentId: client.resolveAgentId(agentId),
            expectedStatuses: expectedStatuses ?? ["todo", "backlog", "blocked"],
          },
        }),
    ),
    makeTool(
      "workcellReleaseIssue",
      "Release an issue checkout",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/release`, { body: {} }),
    ),
    makeTool(
      "workcellAddComment",
      "Add a comment to an issue; include resume=true when intentionally requesting follow-up on resumable closed work",
      addCommentToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/comments`, { body }),
    ),
    makeTool(
      "workcellSuggestTasks",
      "Create a suggest_tasks interaction on an issue",
      createSuggestTasksToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "suggest_tasks",
            ...body,
          },
        }),
    ),
    makeTool(
      "workcellAskUserQuestions",
      "Create an ask_user_questions interaction on an issue",
      createAskUserQuestionsToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "ask_user_questions",
            ...body,
          },
        }),
    ),
    makeTool(
      "workcellRequestConfirmation",
      "Create a request_confirmation interaction on an issue",
      createRequestConfirmationToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "request_confirmation",
            ...body,
          },
        }),
    ),
    makeTool(
      "workcellUpsertIssueDocument",
      "Create or update an issue document",
      upsertDocumentToolSchema,
      async ({ issueId, key, ...body }) =>
        client.requestJson(
          "PUT",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
          { body },
        ),
    ),
    makeTool(
      "workcellRestoreIssueDocumentRevision",
      "Restore a prior revision of an issue document",
      z.object({
        issueId: issueIdSchema,
        key: documentKeySchema,
        revisionId: z.string().uuid(),
      }),
      async ({ issueId, key, revisionId }) =>
        client.requestJson(
          "POST",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions/${encodeURIComponent(revisionId)}/restore`,
          { body: {} },
        ),
    ),
    makeTool(
      "workcellLinkIssueApproval",
      "Link an approval to an issue",
      z.object({ issueId: issueIdSchema }).merge(linkIssueApprovalSchema),
      async ({ issueId, approvalId }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/approvals`, {
          body: { approvalId },
        }),
    ),
    makeTool(
      "workcellUnlinkIssueApproval",
      "Unlink an approval from an issue",
      z.object({ issueId: issueIdSchema, approvalId: approvalIdSchema }),
      async ({ issueId, approvalId }) =>
        client.requestJson(
          "DELETE",
          `/issues/${encodeURIComponent(issueId)}/approvals/${encodeURIComponent(approvalId)}`,
        ),
    ),
    makeTool(
      "workcellApprovalDecision",
      "Approve, reject, request revision, or resubmit an approval",
      approvalDecisionSchema,
      async ({ approvalId, action, decisionNote, payloadJson }) => {
        const path =
          action === "approve"
            ? `/approvals/${encodeURIComponent(approvalId)}/approve`
            : action === "reject"
              ? `/approvals/${encodeURIComponent(approvalId)}/reject`
              : action === "requestRevision"
                ? `/approvals/${encodeURIComponent(approvalId)}/request-revision`
                : `/approvals/${encodeURIComponent(approvalId)}/resubmit`;

        const body =
          action === "resubmit"
            ? { payload: parseOptionalJson(payloadJson) ?? {} }
            : { decisionNote };

        return client.requestJson("POST", path, { body });
      },
    ),
    makeTool(
      "workcellAddApprovalComment",
      "Add a comment to an approval",
      z.object({ approvalId: approvalIdSchema, body: z.string().min(1) }),
      async ({ approvalId, body }) =>
        client.requestJson("POST", `/approvals/${encodeURIComponent(approvalId)}/comments`, {
          body: { body },
        }),
    ),
    makeTool(
      "workcellApiRequest",
      "Make a JSON request to an existing Workcell /api endpoint for unsupported operations",
      apiRequestSchema,
      async ({ method, path, jsonBody }) => {
        if (!path.startsWith("/") || path.includes("..")) {
          throw new Error("path must start with / and be relative to /api, and must not contain '..'");
        }
        return client.requestJson(method, path, {
          body: parseOptionalJson(jsonBody),
        });
      },
    ),
    // WC-62 (D12): expose the Knowledge Graph to external agents over the
    // inbound MCP transport. Read + backfill only — arbitrary node/edge
    // writes (graphUpsert) need a dedicated REST route + authz review and are
    // a deferred follow-up.
    makeTool(
      "workcellGraphNodes",
      "List knowledge-graph nodes for a company by kind (issue, code, plan_section, decision, run, skill, plugin, capability)",
      z.object({ companyId: companyIdOptional, kind: z.string().trim().min(1).optional() }),
      async ({ companyId, kind }) => {
        const cid = client.resolveCompanyId(companyId);
        const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
        return client.requestJson("GET", `/companies/${cid}/knowledge-graph/nodes${qs}`);
      },
    ),
    makeTool(
      "workcellGraphNeighborhood",
      "Get the 1-hop neighborhood (edges + neighbor nodes) of a knowledge-graph node",
      z.object({ companyId: companyIdOptional, nodeId: z.string().uuid() }),
      async ({ companyId, nodeId }) => {
        const cid = client.resolveCompanyId(companyId);
        return client.requestJson(
          "GET",
          `/companies/${cid}/knowledge-graph/neighborhood/${encodeURIComponent(nodeId)}`,
        );
      },
    ),
    makeTool(
      "workcellGraphSyncIssues",
      "Backfill all of a company's issues into the knowledge graph (idempotent)",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => {
        const cid = client.resolveCompanyId(companyId);
        return client.requestJson("POST", `/companies/${cid}/knowledge-graph/sync-issues`);
      },
    ),
    // WC-181 (slice 4): self-managed per-agent memory. Each tool acts on the
    // CALLING agent's own memory only (its id comes from the client config, and
    // the slice-2 route 403s any other :agentId).
    makeTool(
      "memory_remember",
      "Store a durable fact, decision, or preference about this company, its people, projects, or long-running context that should survive beyond this run. Use kind=fact for stable truths, decision for choices made, preference for how the board/team likes things, entity for a person/system/project, todo for a durable reminder. Idempotent on (kind,label): re-remembering the same label updates it in place. Do NOT store throwaway working notes.",
      memoryRememberSchema,
      async ({ kind, label, content, metadata }) => {
        const agentId = client.resolveAgentId();
        const runId = client.defaults.runId;
        const body: Record<string, unknown> = { kind, label, content };
        if (metadata !== undefined) body.metadata = metadata;
        // Stamp provenance with the current heartbeat run so the memory's
        // "Source run" link resolves in the UI. The run id also flows as the
        // X-Workcell-Run-Id header on this write.
        if (runId) body.sourceRunId = runId;
        return client.requestJson(
          "POST",
          `/agents/${encodeURIComponent(agentId)}/memory/nodes`,
          { body },
        );
      },
    ),
    makeTool(
      "memory_forget",
      "Delete a memory that is now stale, wrong, superseded, or irrelevant. Pass nodeId, or identify it by both kind and label. Forgetting keeps your memory accurate — prune aggressively when a fact no longer holds.",
      memoryForgetSchema,
      async ({ nodeId, kind, label }) => {
        if (!nodeId && !(kind && label)) {
          throw new Error(
            "Provide either nodeId, or both kind and label, to identify the memory to forget",
          );
        }
        const agentId = client.resolveAgentId();
        let targetId = nodeId ?? null;
        if (!targetId) {
          // Identity forget: resolve the id from the agent's own graph. Scope is
          // already the calling agent, so this can only ever match its own node.
          const graph = await recallMemoryGraph(client);
          const match = graph.nodes.find(
            (node) => node.kind === kind && node.label === label,
          );
          if (!match) {
            return { forgotten: false, reason: "No memory matched the given kind and label" };
          }
          targetId = match.id;
        }
        return client.requestJson(
          "DELETE",
          `/agents/${encodeURIComponent(agentId)}/memory/nodes/${encodeURIComponent(targetId)}`,
        );
      },
    ),
    makeTool(
      "memory_recall",
      "Look up what you remembered before — call this at the start of work that depends on prior context (who the board is, decisions already made, project specifics). Optionally filter by kind. Returns your durable memory as a compact list.",
      memoryRecallSchema,
      async ({ kind }) => {
        const graph = await recallMemoryGraph(client);
        const nodes = kind ? graph.nodes.filter((node) => node.kind === kind) : graph.nodes;
        return {
          count: nodes.length,
          memories: nodes.map((node) => ({
            id: node.id,
            kind: node.kind,
            label: node.label,
            content: node.content ?? "",
          })),
          edges: graph.edges,
        };
      },
    ),
    makeTool(
      "memory_link",
      "Create a typed relation between two of your own remembered nodes (e.g. a decision that supersedes another, an entity that owns a project). Idempotent on (from,to,relation).",
      memoryLinkSchema,
      async ({ fromNodeId, toNodeId, relation, metadata }) => {
        const agentId = client.resolveAgentId();
        const body: Record<string, unknown> = { fromNodeId, toNodeId, relation };
        if (metadata !== undefined) body.metadata = metadata;
        return client.requestJson(
          "POST",
          `/agents/${encodeURIComponent(agentId)}/memory/edges`,
          { body },
        );
      },
    ),
    // WC-182g (D22): designer-agent design tools. The Open Design 시안 is the
    // source of truth for a UI/screen task — these let the designer agent attach
    // a 시안 it generated and open the board's design-review gate on it.
    makeTool(
      "design_attach",
      "Attach ONE screen's design 시안 (mockup) for the issue (D22). Provide `html` for a self-contained HTML mockup you generated (preferred — embedded as a preview, no hosting needed) or `url` for an externally hosted design. CRITICAL: attach exactly ONE screen/page per call — if the issue needs several screens, call design_attach once per screen (do NOT pack multiple pages into one 시안). Set `screenName` (e.g. \"로그인\") and `screenKey` — a STABLE slug for the screen that is the SAME for EVERY version/revision of that screen (e.g. \"learner-home\"). NEVER bake the version, issue id, or 'staging' into screenKey (NOT \"learner-home-v9\", NOT \"home-lor476\"): a version-specific key forks each revision into a SEPARATE screen and breaks supersession (the board sees 3 copies of one screen instead of the latest). Re-attaching an improved version of a screen MUST reuse that screen's existing screenKey. Declare navigation via `links`: each entry { label, targetScreenKey } means an element on THIS screen (described by label, e.g. \"시작하기 버튼\") opens targetScreenKey — this builds the wireframe flow. Put this screen's SPEC in `planMarkdown` — its purpose, key states (empty/loading/error), interactions, and data — as the paired \"화면 기획\" (screen plan); keep the 시안 HTML itself a PURE rendered screen, NOT a spec document with annotations baked in. Set `formFactor` to mobile | tablet | desktop so the blueprint renders this node at the right size/aspect (default mobile) — use desktop for wide admin/dashboard screens. By default this becomes the screen's authoritative source-of-truth design (makeAuthoritative=true). After attaching all screens, call design_submit_for_review on each to open the board's review gate. Returns the created design work product (id + reviewState).",
      designAttachSchema,
      async ({ issueId, title, html, url, type, summary, screenKey, screenName, links, planMarkdown, formFactor, makeAuthoritative }) => {
        const resolvedUrl = html !== undefined ? await attachSianHtml(client, html) : url;
        if (!resolvedUrl) {
          throw new Error("Provide either html (a self-contained mockup) or url (an external design)");
        }
        const body: Record<string, unknown> = {
          type,
          title,
          url: resolvedUrl,
          isPrimary: makeAuthoritative,
        };
        if (summary !== undefined) body.summary = summary;
        if (screenKey !== undefined) body.screenKey = screenKey;
        if (screenName !== undefined) body.screenName = screenName;
        if (links !== undefined && links.length > 0) body.links = links;
        if (planMarkdown !== undefined) body.planMarkdown = planMarkdown;
        if (formFactor !== undefined) body.formFactor = formFactor;
        return client.requestJson(
          "POST",
          `/issues/${encodeURIComponent(issueId)}/design-artifacts`,
          { body },
        );
      },
    ),
    makeTool(
      "design_submit_for_review",
      "Open the board's design-review gate on an attached 시안 (D22). Promotes the design work product to its issue's authoritative source-of-truth design and advances the review gate to needs_board_review, so the board can approve or request changes. The design is the source of truth: development holds until the board approves it. Call this after design_attach. Returns the updated work product (reviewState: needs_board_review).",
      designSubmitForReviewSchema,
      async ({ workProductId }) =>
        client.requestJson(
          "POST",
          `/work-products/${encodeURIComponent(workProductId)}/design-review/submit`,
          { body: {} },
        ),
    ),
  ];
}
