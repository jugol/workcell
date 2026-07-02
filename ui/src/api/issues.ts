import type {
  AskUserQuestionsAnswer,
  Approval,
  CreateIssueTreeHold,
  DocumentRevision,
  FeedbackTargetType,
  FeedbackTrace,
  FeedbackVote,
  Issue,
  IssueAttachment,
  IssueCostSummary,
  IssueComment,
  IssueDesignRequirement,
  IssueDocument,
  IssueLabel,
  IssueRecoveryAction,
  IssueRetryNowResponse,
  IssueThreadInteraction,
  IssueTreeControlPreview,
  IssueTreeHold,
  IssueWorkProduct,
  PreviewIssueTreeControl,
  ReleaseIssueTreeHold,
  UpsertIssueDocument,
} from "@workcell/shared";
import { api } from "./client";

export type IssueUpdateResponse = Issue & {
  comment?: IssueComment | null;
};

export type ResolveRecoveryActionResponse = {
  issue: Issue;
  recoveryAction: IssueRecoveryAction;
};

// WC-184 (CP0 "Grill mode"): one clarifying question the planner returns before
// drafting, with its recommended answer + a one-line rationale.
export type GrillQuestion = {
  question: string;
  recommendation: string;
  rationale: string;
};

export const issuesApi = {
  list: (
    companyId: string,
    filters?: {
      attention?: "blocked";
      status?: string;
      projectId?: string;
      parentId?: string;
      assigneeAgentId?: string;
      participantAgentId?: string;
      assigneeUserId?: string;
      touchedByUserId?: string;
      inboxArchivedByUserId?: string;
      unreadForUserId?: string;
      labelId?: string;
      workspaceId?: string;
      executionWorkspaceId?: string;
      originKind?: string;
      originKindPrefix?: string;
      originId?: string;
      descendantOf?: string;
      includeRoutineExecutions?: boolean;
      includeBlockedBy?: boolean;
      includeBlockedInboxAttention?: boolean;
      q?: string;
      limit?: number;
      offset?: number;
      sortField?: "updated";
      sortDir?: "asc" | "desc";
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.attention) params.set("attention", filters.attention);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.parentId) params.set("parentId", filters.parentId);
    if (filters?.assigneeAgentId) params.set("assigneeAgentId", filters.assigneeAgentId);
    if (filters?.participantAgentId) params.set("participantAgentId", filters.participantAgentId);
    if (filters?.assigneeUserId) params.set("assigneeUserId", filters.assigneeUserId);
    if (filters?.touchedByUserId) params.set("touchedByUserId", filters.touchedByUserId);
    if (filters?.inboxArchivedByUserId) params.set("inboxArchivedByUserId", filters.inboxArchivedByUserId);
    if (filters?.unreadForUserId) params.set("unreadForUserId", filters.unreadForUserId);
    if (filters?.labelId) params.set("labelId", filters.labelId);
    if (filters?.workspaceId) params.set("workspaceId", filters.workspaceId);
    if (filters?.executionWorkspaceId) params.set("executionWorkspaceId", filters.executionWorkspaceId);
    if (filters?.originKind) params.set("originKind", filters.originKind);
    if (filters?.originKindPrefix) params.set("originKindPrefix", filters.originKindPrefix);
    if (filters?.originId) params.set("originId", filters.originId);
    if (filters?.descendantOf) params.set("descendantOf", filters.descendantOf);
    if (filters?.includeRoutineExecutions) params.set("includeRoutineExecutions", "true");
    if (filters?.includeBlockedBy) params.set("includeBlockedBy", "true");
    if (filters?.includeBlockedInboxAttention) params.set("includeBlockedInboxAttention", "true");
    if (filters?.q) params.set("q", filters.q);
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
    if (filters?.sortField) params.set("sortField", filters.sortField);
    if (filters?.sortDir) params.set("sortDir", filters.sortDir);
    const qs = params.toString();
    return api.get<Issue[]>(`/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
  },
  count: (
    companyId: string,
    filters: {
      attention: "blocked";
      status?: string;
      assigneeAgentId?: string;
      assigneeUserId?: string;
      projectId?: string;
      labelId?: string;
      q?: string;
    },
  ) => {
    const params = new URLSearchParams();
    params.set("attention", filters.attention);
    if (filters.status) params.set("status", filters.status);
    if (filters.assigneeAgentId) params.set("assigneeAgentId", filters.assigneeAgentId);
    if (filters.assigneeUserId) params.set("assigneeUserId", filters.assigneeUserId);
    if (filters.projectId) params.set("projectId", filters.projectId);
    if (filters.labelId) params.set("labelId", filters.labelId);
    if (filters.q) params.set("q", filters.q);
    return api.get<{ count: number }>(`/companies/${companyId}/issues/count?${params.toString()}`);
  },
  listLabels: (companyId: string) => api.get<IssueLabel[]>(`/companies/${companyId}/labels`),
  createLabel: (companyId: string, data: { name: string; color: string }) =>
    api.post<IssueLabel>(`/companies/${companyId}/labels`, data),
  deleteLabel: (id: string) => api.delete<IssueLabel>(`/labels/${id}`),
  get: (id: string) => api.get<Issue>(`/issues/${id}`),
  // WC-195/196: set the design-first gate opt-out for an issue. { required:false }
  // exempts it (e.g. backend-only work); { required:true } requires a design.
  setDesignRequirement: (
    id: string,
    body: { required: boolean; reason?: string | null },
  ) =>
    api.post<{ ok: boolean; designRequirement: IssueDesignRequirement }>(
      `/issues/${id}/design-requirement`,
      body,
    ),
  markRead: (id: string) => api.post<{ id: string; lastReadAt: Date }>(`/issues/${id}/read`, {}),
  markUnread: (id: string) => api.delete<{ id: string; removed: boolean }>(`/issues/${id}/read`),
  archiveFromInbox: (id: string) =>
    api.post<{ id: string; archivedAt: Date }>(`/issues/${id}/inbox-archive`, {}),
  unarchiveFromInbox: (id: string) =>
    api.delete<{ id: string; archivedAt: Date } | { ok: true }>(`/issues/${id}/inbox-archive`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Issue>(`/companies/${companyId}/issues`, data),
  draftFromPrompt: (companyId: string, data: { prompt: string; projectId?: string }) =>
    api.post<Issue>(`/companies/${companyId}/issues/draft-from-prompt`, data),
  // WC-184 (CP0 "Grill mode"): fetch clarifying questions for a prompt instead
  // of drafting. Returns each question with a recommended answer + rationale.
  draftGrill: (companyId: string, data: { prompt: string; projectId?: string }) =>
    api.post<{ questions: GrillQuestion[] }>(`/companies/${companyId}/issues/draft-grill`, data),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch<IssueUpdateResponse>(`/issues/${id}`, data),
  resolveRecoveryAction: (
    id: string,
    data: {
      actionId?: string;
      outcome: "restored" | "false_positive" | "blocked" | "cancelled";
      sourceIssueStatus: "todo" | "done" | "in_review" | "blocked";
      resolutionNote?: string | null;
    },
  ) => api.post<ResolveRecoveryActionResponse>(`/issues/${id}/recovery-actions/resolve`, data),
  previewTreeControl: (id: string, data: PreviewIssueTreeControl) =>
    api.post<IssueTreeControlPreview>(`/issues/${id}/tree-control/preview`, data),
  createTreeHold: (id: string, data: CreateIssueTreeHold) =>
    api.post<{ hold: IssueTreeHold; preview: IssueTreeControlPreview }>(`/issues/${id}/tree-holds`, data),
  getTreeHold: (id: string, holdId: string) =>
    api.get<IssueTreeHold>(`/issues/${id}/tree-holds/${holdId}`),
  listTreeHolds: (
    id: string,
    filters?: {
      status?: "active" | "released";
      mode?: "pause" | "resume" | "cancel" | "restore";
      includeMembers?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.mode) params.set("mode", filters.mode);
    if (filters?.includeMembers) params.set("includeMembers", "true");
    const qs = params.toString();
    return api.get<IssueTreeHold[]>(`/issues/${id}/tree-holds${qs ? `?${qs}` : ""}`);
  },
  getTreeControlState: (id: string) =>
    api.get<{
      activePauseHold: {
        holdId: string;
        rootIssueId: string;
        issueId: string;
        isRoot: boolean;
        mode: "pause";
        reason: string | null;
        releasePolicy: { strategy: "manual" | "after_active_runs_finish"; note?: string | null } | null;
      } | null;
    }>(`/issues/${id}/tree-control/state`),
  releaseTreeHold: (id: string, holdId: string, data: ReleaseIssueTreeHold) =>
    api.post<IssueTreeHold>(`/issues/${id}/tree-holds/${holdId}/release`, data),
  checkMonitorNow: (id: string) => api.post<{ ok: true }>(`/issues/${id}/monitor/check-now`, {}),
  retryScheduledRetryNow: (id: string) =>
    api.post<IssueRetryNowResponse>(`/issues/${id}/scheduled-retry/retry-now`, {}),
  remove: (id: string) => api.delete<Issue>(`/issues/${id}`),
  checkout: (id: string, agentId: string) =>
    api.post<Issue>(`/issues/${id}/checkout`, {
      agentId,
      expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
    }),
  release: (id: string) => api.post<Issue>(`/issues/${id}/release`, {}),
  listComments: (
    id: string,
    filters?: {
      after?: string;
      order?: "asc" | "desc";
      limit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.after) params.set("after", filters.after);
    if (filters?.order) params.set("order", filters.order);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<IssueComment[]>(`/issues/${id}/comments${qs ? `?${qs}` : ""}`);
  },
  listInteractions: (id: string) =>
    api.get<IssueThreadInteraction[]>(`/issues/${id}/interactions`),
  createInteraction: (id: string, data: Record<string, unknown>) =>
    api.post<IssueThreadInteraction>(`/issues/${id}/interactions`, data),
  acceptInteraction: (
    id: string,
    interactionId: string,
    data?: { selectedClientKeys?: string[] },
  ) =>
    api.post<IssueThreadInteraction>(`/issues/${id}/interactions/${interactionId}/accept`, data ?? {}),
  rejectInteraction: (id: string, interactionId: string, reason?: string) =>
    api.post<IssueThreadInteraction>(`/issues/${id}/interactions/${interactionId}/reject`, reason ? { reason } : {}),
  cancelInteraction: (id: string, interactionId: string, reason?: string) =>
    api.post<IssueThreadInteraction>(`/issues/${id}/interactions/${interactionId}/cancel`, reason ? { reason } : {}),
  respondToInteraction: (
    id: string,
    interactionId: string,
    data: { answers: AskUserQuestionsAnswer[]; summaryMarkdown?: string | null },
  ) =>
    api.post<IssueThreadInteraction>(`/issues/${id}/interactions/${interactionId}/respond`, data),
  getComment: (id: string, commentId: string) =>
    api.get<IssueComment>(`/issues/${id}/comments/${commentId}`),
  listFeedbackVotes: (id: string) => api.get<FeedbackVote[]>(`/issues/${id}/feedback-votes`),
  getCostSummary: (id: string, options: { excludeRoot?: boolean } = {}) => {
    const qs = options.excludeRoot ? "?excludeRoot=true" : "";
    return api.get<IssueCostSummary>(`/issues/${id}/cost-summary${qs}`);
  },
  listFeedbackTraces: (id: string, filters?: Record<string, string | boolean | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return api.get<FeedbackTrace[]>(`/issues/${id}/feedback-traces${qs ? `?${qs}` : ""}`);
  },
  upsertFeedbackVote: (
    id: string,
    data: {
      targetType: FeedbackTargetType;
      targetId: string;
      vote: "up" | "down";
      reason?: string;
      allowSharing?: boolean;
    },
  ) => api.post<FeedbackVote>(`/issues/${id}/feedback-votes`, data),
  addComment: (id: string, body: string, reopen?: boolean, interrupt?: boolean) =>
    api.post<IssueComment>(
      `/issues/${id}/comments`,
      {
        body,
        ...(reopen === undefined ? {} : { reopen }),
        ...(interrupt === undefined ? {} : { interrupt }),
      },
    ),
  cancelComment: (id: string, commentId: string) =>
    api.delete<IssueComment>(`/issues/${id}/comments/${commentId}`),
  listDocuments: (id: string, options?: { includeSystem?: boolean }) =>
    api.get<IssueDocument[]>(
      `/issues/${id}/documents${options?.includeSystem ? "?includeSystem=true" : ""}`,
    ),
  getDocument: (id: string, key: string) => api.get<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`),
  upsertDocument: (id: string, key: string, data: UpsertIssueDocument) =>
    api.put<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`, data),
  lockDocument: (id: string, key: string) =>
    api.post<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}/lock`, {}),
  unlockDocument: (id: string, key: string) =>
    api.post<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}/unlock`, {}),
  listDocumentRevisions: (id: string, key: string) =>
    api.get<DocumentRevision[]>(`/issues/${id}/documents/${encodeURIComponent(key)}/revisions`),
  restoreDocumentRevision: (id: string, key: string, revisionId: string) =>
    api.post<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}/revisions/${revisionId}/restore`, {}),
  deleteDocument: (id: string, key: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/documents/${encodeURIComponent(key)}`),
  listAttachments: (id: string) => api.get<IssueAttachment[]>(`/issues/${id}/attachments`),
  uploadAttachment: (
    companyId: string,
    issueId: string,
    file: File,
    issueCommentId?: string | null,
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (issueCommentId) {
      form.append("issueCommentId", issueCommentId);
    }
    return api.postForm<IssueAttachment>(`/companies/${companyId}/issues/${issueId}/attachments`, form);
  },
  deleteAttachment: (id: string) => api.delete<{ ok: true }>(`/attachments/${id}`),
  listApprovals: (id: string) => api.get<Approval[]>(`/issues/${id}/approvals`),
  linkApproval: (id: string, approvalId: string) =>
    api.post<Approval[]>(`/issues/${id}/approvals`, { approvalId }),
  unlinkApproval: (id: string, approvalId: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/approvals/${approvalId}`),
  listWorkProducts: (id: string) => api.get<IssueWorkProduct[]>(`/issues/${id}/work-products`),
  createWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.post<IssueWorkProduct>(`/issues/${id}/work-products`, data),
  updateWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.patch<IssueWorkProduct>(`/work-products/${id}`, data),
  deleteWorkProduct: (id: string) => api.delete<IssueWorkProduct>(`/work-products/${id}`),
  // WC-182e: attach a design 시안 to an issue. Creates a design-type work product
  // (status active, reviewState none); with isPrimary it becomes the issue's
  // authoritative source-of-truth design. Defaults (type "design", provider
  // "workcell") are applied server-side. Returns the created work product.
  createDesignArtifact: (
    issueId: string,
    data: {
      title: string;
      url?: string;
      type?: string;
      summary?: string;
      isPrimary?: boolean;
      // Provenance for designs pulled from the project design system catalog
      // (e.g. { sourceWorkProductId }) — the screen 시안 reused as this issue's
      // source of truth.
      metadata?: Record<string, unknown> | null;
    },
  ) => api.post<IssueWorkProduct>(`/issues/${issueId}/design-artifacts`, data),
  // WC-182 / D22: design-review gate actions on a design-type work product.
  // submit → marks it authoritative (isPrimary) + reviewState needs_board_review
  // (designer/agent or board); approve / request-changes are board-only. Each
  // returns the updated work product. Errors surface as 422 (not a design type),
  // 409 (invalid transition), 403 (board required), 404 (missing).
  submitDesignReview: (id: string) =>
    api.post<IssueWorkProduct>(`/work-products/${id}/design-review/submit`, {}),
  approveDesignReview: (id: string) =>
    api.post<IssueWorkProduct>(`/work-products/${id}/design-review/approve`, {}),
  requestDesignChanges: (id: string, reason?: string) =>
    api.post<IssueWorkProduct>(
      `/work-products/${id}/design-review/request-changes`,
      reason ? { reason } : {},
    ),
  // WC-188 / CP7: submit user feedback on the issue's PLAN/기획. Records the
  // feedback (board comment + activity) and wakes the planner-capable agent to
  // revise the plan — the PLAN-side mirror of requestDesignChanges. 409 when no
  // planner-capable agent exists; board-only; tenant-scoped.
  requestPlanRevision: (id: string, feedback: string) =>
    api.post<{ ok: true; comment: IssueComment; plannerAgentId: string }>(
      `/issues/${id}/plan/request-revision`,
      { feedback },
    ),
  // WC-14: trigger the compound-followups sweep for an issue with a
  // populated compound-checklist document. Returns the ids of the newly
  // created child issues; idempotent on the server (existing
  // compound_followup children with matching titles are skipped).
  processCompoundFollowups: (id: string) =>
    api.post<{ createdIssueIds: string[] }>(`/issues/${id}/compound-followups/process`, {}),
  // WC-19: spawn a Planner-capable agent child issue that fills the
  // compound-checklist body (sections 1–4). Returns the child issue and
  // whether an in-flight one was reused (`reused: true` if so).
  requestCompoundChecklistAutofill: (id: string) =>
    api.post<{ issue: Issue; reused: boolean }>(`/issues/${id}/compound-checklist/auto-fill`, {}),
  // WC-22: returns the in-flight autofill child issue summary (or null when
  // none active). The UI uses this to render an "agent is reviewing" banner
  // on the compound-checklist document so users see status without polling
  // the whole issue tree.
  getCompoundChecklistAutofillStatus: (id: string) =>
    api.get<{
      inFlight: {
        id: string;
        identifier: string | null;
        title: string;
        status: string;
        assigneeAgentId: string | null;
        createdAt: string;
      } | null;
    }>(`/issues/${id}/compound-checklist/autofill-status`),

  // WC-43 (PLAN §9 #9 UI): trigger on-demand context compaction. Refreshes
  // the continuation-summary document for this issue based on its most
  // recent run. 409 with code=no_run_available when the issue has no run
  // yet — caller should kick off a run first.
  compactContext: (id: string) =>
    api.post<{ summary: IssueDocument }>(`/issues/${id}/compact-context`, {}),
};
