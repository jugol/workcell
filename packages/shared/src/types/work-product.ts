export type IssueWorkProductType =
  | "preview_url"
  | "runtime_service"
  | "pull_request"
  | "branch"
  | "commit"
  | "artifact"
  | "document"
  | "proof"
  // "전체 앱 기획" redesign: the "화면 기획" (screen plan), paired 1:1 to a pure-
  // screen 시안 by canonical screenKey. Deliberately NOT a design type
  // (DESIGN_WORK_PRODUCT_TYPES) — never a flow node, never holds the design gate,
  // and immune to the mockup supersession sweep.
  | "screen_plan";

export type IssueWorkProductProvider =
  | "workcell"
  | "github"
  | "vercel"
  | "s3"
  | "custom";

export type IssueWorkProductStatus =
  | "active"
  | "ready_for_review"
  | "approved"
  | "changes_requested"
  | "merged"
  | "closed"
  | "failed"
  | "archived"
  | "draft";

export type IssueWorkProductReviewState =
  | "none"
  | "needs_board_review"
  | "approved"
  | "changes_requested";

export interface IssueWorkProduct {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string;
  executionWorkspaceId: string | null;
  runtimeServiceId: string | null;
  type: IssueWorkProductType;
  provider: IssueWorkProductProvider | string;
  externalId: string | null;
  // Design-system redesign: SCREEN IDENTITY (one issue → many screens, one
  // screen per artifact). screenKey is a stable slug for a canonical app page;
  // screenName its display label. Null on non-design / legacy rows — callers use
  // effectiveScreenKey() (design-screens.ts) which falls back to title lineage.
  screenKey: string | null;
  screenName: string | null;
  // Screen form factor hint ("mobile" | "tablet" | "desktop") — drives flow node
  // sizing. Optional/back-compat for non-design and legacy rows.
  formFactor?: string | null;
  title: string;
  url: string | null;
  status: IssueWorkProductStatus | string;
  reviewState: IssueWorkProductReviewState;
  isPrimary: boolean;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  summary: string | null;
  metadata: Record<string, unknown> | null;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
