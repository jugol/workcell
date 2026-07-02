import { Router } from "express";
import { and, eq, inArray, desc, type SQL } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { issueWorkProducts, issues, projects } from "@workcell/db";
import { isUuidLike } from "@workcell/shared";
import { assertCompanyAccess } from "./authz.js";
import { DESIGN_WORK_PRODUCT_TYPES } from "../services/design-artifact-types.js";

// WC-40 (PLAN §9 #4 / D13): Open Design artifact listing.
//
// Per D13 the Open Design Dashboard surfaces design artifacts that live
// in issue_work_products + assets — no new table. This route filters
// work_products to the design-related type set so the Open Design plugin
// (and any other consumer) can render them without hand-rolling the
// type-filter logic.
//
// Type set is open-enum and extensible — callers can pass ?types=...
// to override. The default covers the common cases (`design`, `ui_preview`,
// `mockup`, `screenshot`, `figma_frame`).
//
// WC-182 / D22: the design-type set now lives in services/design-artifact-types
// so the source-of-truth-design logic in work-products.ts and this route share
// ONE definition. Re-exported here under the original name so existing callers
// of DEFAULT_DESIGN_ARTIFACT_TYPES keep working unchanged.
export const DEFAULT_DESIGN_ARTIFACT_TYPES = DESIGN_WORK_PRODUCT_TYPES;

function parseTypes(typesRaw: string | undefined): string[] {
  return typesRaw && typesRaw.trim().length > 0
    ? typesRaw.split(",").map((t) => t.trim()).filter(Boolean)
    : [...DEFAULT_DESIGN_ARTIFACT_TYPES];
}

// Shared select shape for both the company-wide and project-scoped listings.
const ARTIFACT_SELECTION = {
  id: issueWorkProducts.id,
  companyId: issueWorkProducts.companyId,
  // screen_key is PROJECT-scoped (company fallback): the same slug ("home",
  // "login") can name different screens in different projects. Return projectId
  // so the inbox can scope its "screen already approved elsewhere" suppression —
  // without it, an approved 'home' in project A silently hid a pending 'home'
  // review in project B from both the To-do list and the badge.
  projectId: issueWorkProducts.projectId,
  issueId: issueWorkProducts.issueId,
  type: issueWorkProducts.type,
  provider: issueWorkProducts.provider,
  title: issueWorkProducts.title,
  status: issueWorkProducts.status,
  // WC-192/194: reviewState + isPrimary let the Design System window mark
  // the authoritative/approved design and show review status per artifact.
  // (WC-194 dropped the soft-archive/deprecated fields — superseded designs
  // are hard-deleted on approval, so the listing is already the live set.)
  reviewState: issueWorkProducts.reviewState,
  isPrimary: issueWorkProducts.isPrimary,
  // Design-system redesign: screen identity so the catalog groups artifacts by
  // screen (one card per screen) and the flow dashboard can anchor nav links.
  screenKey: issueWorkProducts.screenKey,
  screenName: issueWorkProducts.screenName,
  externalId: issueWorkProducts.externalId,
  // WC-55 (#4 overclaim fix): return the artifact URL + summary so the
  // Open Design plugin's iframe preview and version-diff operate on
  // REAL data instead of about:blank / synthetic strings. Aliased to
  // previewUrl/body to match the plugin UI's expected shape.
  previewUrl: issueWorkProducts.url,
  body: issueWorkProducts.summary,
  createdAt: issueWorkProducts.createdAt,
  updatedAt: issueWorkProducts.updatedAt,
  // The linked issue's status (null for project-level artifacts). Lets the inbox
  // hide design reviews for terminal issues (done/cancelled) — reviewing a
  // finished issue's 시안 is moot, so it must not sit in the board's "할 일".
  issueStatus: issues.status,
};

export function designArtifactRoutes(db: Db) {
  const router = Router();

  async function listArtifacts(types: string[], extraConditions: SQL[]) {
    return db
      .select(ARTIFACT_SELECTION)
      .from(issueWorkProducts)
      // LEFT JOIN so project-level artifacts (issueId null) still list; their
      // issueStatus comes back null and the inbox treats them as non-terminal.
      .leftJoin(issues, eq(issues.id, issueWorkProducts.issueId))
      .where(and(inArray(issueWorkProducts.type, types), ...extraConditions))
      .orderBy(desc(issueWorkProducts.createdAt));
  }

  router.get("/companies/:companyId/design-artifacts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const types = parseTypes(req.query.types as string | undefined);
    if (types.length === 0) {
      res.json({ items: [] });
      return;
    }

    const items = await listArtifacts(types, [
      eq(issueWorkProducts.companyId, companyId),
    ]);
    res.json({ items });
  });

  // Project-scoped Design System listing: each project owns its design
  // source of truth, so the ProjectDetail "Design System" tab lists only
  // the artifacts tied to that project (issue_work_products.project_id).
  // The company-wide route above stays as the team-level overview.
  router.get("/projects/:projectId/design-artifacts", async (req, res) => {
    const projectId = req.params.projectId as string;
    // Non-UUID refs can't match a project row — answer 404 instead of letting
    // Postgres throw a uuid-cast error (500).
    if (!isUuidLike(projectId)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const [project] = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);

    const types = parseTypes(req.query.types as string | undefined);
    if (types.length === 0) {
      res.json({ items: [] });
      return;
    }

    const items = await listArtifacts(types, [
      eq(issueWorkProducts.companyId, project.companyId),
      eq(issueWorkProducts.projectId, projectId),
    ]);
    res.json({ items });
  });

  return router;
}
