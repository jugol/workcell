// WC-182 / D22: single source of truth for the design-type work-product set,
// shared across server and UI.
//
// The Open Design 시안 (design artifact) is the SOURCE OF TRUTH for an app /
// project task. At the data layer the design-type work products on an issue are
// the candidates for that issue's authoritative source-of-truth design (the one
// with isPrimary === true). Server services, server routes, and the board UI
// must all agree on which `type` values count as "design", so the list lives
// here once and is imported from @workcell/shared by every consumer.
//
// These are open-enum text values stored in issue_work_products.type; they are
// intentionally NOT part of the narrow IssueWorkProductType union.
export const DESIGN_WORK_PRODUCT_TYPES = [
  "design",
  "ui_preview",
  "mockup",
  "screenshot",
  "figma_frame",
] as const;

export type DesignWorkProductType = (typeof DESIGN_WORK_PRODUCT_TYPES)[number];

export function isDesignWorkProductType(type: string): type is DesignWorkProductType {
  return (DESIGN_WORK_PRODUCT_TYPES as readonly string[]).includes(type);
}
