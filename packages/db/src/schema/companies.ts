import { pgTable, uuid, text, integer, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    issuePrefix: text("issue_prefix").notNull().default("PAP"),
    issueCounter: integer("issue_counter").notNull().default(0),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    attachmentMaxBytes: integer("attachment_max_bytes")
      .notNull()
      .default(10 * 1024 * 1024),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(false),
    // WC-195: design-first gate. When true, every issue in this company REQUIRES
    // an approved source-of-truth design before it can reach Done — unless the
    // issue is explicitly exempted (issues.design_requirement = { required:false },
    // set manually or by an AI agent for non-screen work). Default false keeps
    // existing companies byte-identical (design optional).
    requireDesignFirst: boolean("require_design_first").notNull().default(false),
    feedbackDataSharingEnabled: boolean("feedback_data_sharing_enabled")
      .notNull()
      .default(false),
    feedbackDataSharingConsentAt: timestamp("feedback_data_sharing_consent_at", { withTimezone: true }),
    feedbackDataSharingConsentByUserId: text("feedback_data_sharing_consent_by_user_id"),
    feedbackDataSharingTermsVersion: text("feedback_data_sharing_terms_version"),
    // Team autonomy (company-level, board-visible) — replaces hiding these
    // behaviors behind the instance-level EXPERIMENTAL autonomousMode flag.
    // autoApproveConfirmations: auto-accept agent request_confirmation gates
    // (plan/confirmation approvals) as the system instead of waiting for the
    // board. Default FALSE: the board stays in the loop unless opted in.
    autoApproveConfirmations: boolean("auto_approve_confirmations").notNull().default(false),
    // autoRouteNewIssues: board-created top-level issues without an explicit
    // assignee are auto-routed to the company's Orchestrator (lead fallback).
    // Default TRUE: preserves the existing auto-routing behavior.
    autoRouteNewIssues: boolean("auto_route_new_issues").notNull().default(true),
    // pairAutoRunDefault: default autoRunEnabled for NEW pair groups created
    // without an explicit autoRunEnabled input. Default TRUE mirrors the
    // pair_groups.auto_run_enabled column default (0115).
    pairAutoRunDefault: boolean("pair_auto_run_default").notNull().default(true),
    brandColor: text("brand_color"),
    // WC-81: language the planner/Orchestrator writes plan reports & issue
    // drafts in (chosen at onboarding). "en" = no translation directive.
    planReportLanguage: text("plan_report_language").notNull().default("en"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
  }),
);
