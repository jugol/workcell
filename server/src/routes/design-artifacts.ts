import { Router } from "express";
import { and, eq, inArray, desc } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { issueWorkProducts } from "@workcell/db";
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

export function designArtifactRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/design-artifacts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const typesRaw = req.query.types as string | undefined;
    const types =
      typesRaw && typesRaw.trim().length > 0
        ? typesRaw.split(",").map((t) => t.trim()).filter(Boolean)
        : [...DEFAULT_DESIGN_ARTIFACT_TYPES];
    if (types.length === 0) {
      res.json({ items: [] });
      return;
    }

    const items = await db
      .select({
        id: issueWorkProducts.id,
        companyId: issueWorkProducts.companyId,
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
        externalId: issueWorkProducts.externalId,
        // WC-55 (#4 overclaim fix): return the artifact URL + summary so the
        // Open Design plugin's iframe preview and version-diff operate on
        // REAL data instead of about:blank / synthetic strings. Aliased to
        // previewUrl/body to match the plugin UI's expected shape.
        previewUrl: issueWorkProducts.url,
        body: issueWorkProducts.summary,
        createdAt: issueWorkProducts.createdAt,
        updatedAt: issueWorkProducts.updatedAt,
      })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, companyId),
          inArray(issueWorkProducts.type, types),
        ),
      )
      .orderBy(desc(issueWorkProducts.createdAt));

    res.json({ items });
  });

  return router;
}
