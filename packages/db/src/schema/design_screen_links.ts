import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { issueWorkProducts } from "./issue_work_products.js";

// Design-system redesign (R3): explicit screen→screen NAVIGATION edges.
//
// A link means "an element (e.g. a button) on the FROM screen navigates to the
// TO screen". Screens are identified by their stable slug (screen_key, see
// issue_work_products.screen_key), scoped to a project — project_id NULL is the
// company-level "default app" (used when the issue that produced the screen has
// no project, e.g. the current LORO edu-app whose 시안 are project-less).
//
// Links are DECLARED by the designer agent at attach time (design_attach.links)
// and EDITABLE by the board in the flow dashboard. source_work_product_id
// remembers which 시안 declared a link (best-effort provenance; nulled if that
// artifact is deleted). created_by_kind distinguishes 'agent' vs 'board' edits.
export const designScreenLinks = pgTable(
  "design_screen_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    fromScreenKey: text("from_screen_key").notNull(),
    toScreenKey: text("to_screen_key").notNull(),
    label: text("label").notNull().default(""),
    sourceWorkProductId: uuid("source_work_product_id").references(
      () => issueWorkProducts.id,
      { onDelete: "set null" },
    ),
    createdByKind: text("created_by_kind").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("design_screen_links_company_project_idx").on(
      table.companyId,
      table.projectId,
    ),
    // NULLS NOT DISTINCT (set in the migration) so company-level links dedupe.
    unique: uniqueIndex("design_screen_links_unique").on(
      table.companyId,
      table.projectId,
      table.fromScreenKey,
      table.toScreenKey,
      table.label,
    ),
  }),
);
