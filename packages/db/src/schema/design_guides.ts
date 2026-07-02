import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

// Design-system redesign (R1): the single canonical "design system guide" page
// per app.
//
// project_id NULL is the company-level "default app". notes_markdown is the
// board-authored memo LAYERED OVER auto-extracted design tokens — the tokens
// (color/type/spacing/component inventory) are derived ON READ from the app's
// approved screens (designGuideService), not stored here, so the guide stays a
// living document. Exactly one guide per (company, project).
export const designGuides = pgTable(
  "design_guides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    notesMarkdown: text("notes_markdown").notNull().default(""),
    updatedByKind: text("updated_by_kind"),
    updatedById: text("updated_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // NULLS NOT DISTINCT (set in the migration) so the company-level guide is unique.
    companyProjectUnique: uniqueIndex("design_guides_company_project_unique").on(
      table.companyId,
      table.projectId,
    ),
  }),
);
