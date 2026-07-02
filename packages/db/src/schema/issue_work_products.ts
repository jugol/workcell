import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { workspaceRuntimeServices } from "./workspace_runtime_services.js";

export const issueWorkProducts = pgTable(
  "issue_work_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    executionWorkspaceId: uuid("execution_workspace_id")
      .references(() => executionWorkspaces.id, { onDelete: "set null" }),
    runtimeServiceId: uuid("runtime_service_id")
      .references(() => workspaceRuntimeServices.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    // Design-system redesign: SCREEN IDENTITY so one issue can hold MULTIPLE
    // design artifacts (one screen per artifact). screen_key is a stable slug
    // for a canonical app page (project-scoped, company fallback); screen_name
    // is its display label. Nullable — legacy/non-design rows fall back to
    // title-lineage grouping at the service layer (effectiveScreenKey).
    screenKey: text("screen_key"),
    screenName: text("screen_name"),
    // Screen form factor hint (mobile|tablet|desktop) — drives flow node sizing.
    formFactor: text("form_factor"),
    title: text("title").notNull(),
    url: text("url"),
    status: text("status").notNull(),
    reviewState: text("review_state").notNull().default("none"),
    isPrimary: boolean("is_primary").notNull().default(false),
    healthStatus: text("health_status").notNull().default("unknown"),
    summary: text("summary"),
    // "전체 앱 기획" redesign: the "화면 기획" (screen plan) spec body, carried by
    // the non-design 'screen_plan' work-product type and paired to its pure-screen
    // 시안 by the same canonical screen_key. Null on mockup/legacy/non-design rows.
    planMarkdown: text("plan_markdown"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueTypeIdx: index("issue_work_products_company_issue_type_idx").on(
      table.companyId,
      table.issueId,
      table.type,
    ),
    companyExecutionWorkspaceTypeIdx: index("issue_work_products_company_execution_workspace_type_idx").on(
      table.companyId,
      table.executionWorkspaceId,
      table.type,
    ),
    companyProviderExternalIdIdx: index("issue_work_products_company_provider_external_id_idx").on(
      table.companyId,
      table.provider,
      table.externalId,
    ),
    companyUpdatedIdx: index("issue_work_products_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
  }),
);
