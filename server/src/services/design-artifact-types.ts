// WC-182 / D22: the design-type work-product set is now the single source of
// truth defined in @workcell/shared (packages/shared/src/types/design-artifact),
// so the server services, server routes, and the board UI all share ONE list.
//
// This module re-exports the shared definitions under their original names so
// existing server callers (work-products.ts service and the design-artifacts
// route) keep compiling unchanged, while the canonical list lives in shared.
//
// The values are open-enum text stored in issue_work_products.type; they are
// intentionally NOT part of the narrow IssueWorkProductType union.
export {
  DESIGN_WORK_PRODUCT_TYPES,
  isDesignWorkProductType,
  type DesignWorkProductType,
} from "@workcell/shared";
