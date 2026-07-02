import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

// "전체 앱 기획" redesign (R5): persisted per-screen positions on the flow canvas.
//
// Screens are DERIVED (grouped from issue_work_products by their stable
// screen_key) — there is no screen row to hang a position on, and the "current"
// work-product id changes on every revision (old rows are hard-deleted on
// supersession). So positions key off the STABLE canonical screen_key, scoped to
// a project (project_id NULL = company-level default app), exactly like
// design_screen_links. SHARED per app-scope (not per-user). x/y are raw layout
// coordinates in the same space the auto-layout emits, so a positioned node and a
// fallback-laid-out node share one coordinate system and connector arrows stay
// attached. Set by dragging a node; absent rows fall back to auto-layout.
export const designScreenPositions = pgTable(
  "design_screen_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    screenKey: text("screen_key").notNull(),
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    updatedByKind: text("updated_by_kind"),
    updatedById: text("updated_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("design_screen_positions_company_project_idx").on(
      table.companyId,
      table.projectId,
    ),
    // NULLS NOT DISTINCT (set in the migration) so company-level positions dedupe.
    unique: uniqueIndex("design_screen_positions_unique").on(
      table.companyId,
      table.projectId,
      table.screenKey,
    ),
  }),
);
