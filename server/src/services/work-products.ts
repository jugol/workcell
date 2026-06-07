import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { issueWorkProducts, issues, companies } from "@workcell/db";
import type { IssueWorkProduct, IssueWorkProductReviewState } from "@workcell/shared";
import {
  DESIGN_WORK_PRODUCT_TYPES,
  isDesignWorkProductType,
} from "./design-artifact-types.js";

// WC-182 / D22: the isPrimary design-type work product is the issue's
// source-of-truth design; reviewState is its review gate. QA/dev build against
// the approved authoritative design.
//
// The Open Design 시안 is the SOURCE OF TRUTH for an app / project task: design
// drives implementation; QA measures the built UI against the design 시안, not
// the reverse. Concretely: for an issue, the design-type work product flagged
// isPrimary IS that issue's authoritative source-of-truth design, and its
// reviewState is the design-review gate that promotes it to "approved" (the
// state QA/dev should build against).

// Re-export the shared design-type set so callers of the service get the
// source-of-truth design vocabulary without reaching into the route layer.
export { DESIGN_WORK_PRODUCT_TYPES } from "./design-artifact-types.js";

// The design-review gate REUSES the shared IssueWorkProductReviewState vocabulary
// — one model per `reviewState` column, no parallel state names (avoids drift).
// The design gate maps onto the shared union as:
//   none               → not yet submitted for design review
//   needs_board_review → submitted; awaiting the user/board design-review gate (D22)
//   approved           → approved; this design is the confirmed source of truth
//   changes_requested  → changes needed; route back to the designer leg
// `satisfies` pins each entry to a valid IssueWorkProductReviewState, so the
// values persisted here always pass issueWorkProductReviewStateSchema and the
// reviewState mapping in toIssueWorkProduct is honest (no type-lie cast).
export const DESIGN_REVIEW_STATES = [
  "none",
  "needs_board_review",
  "approved",
  "changes_requested",
] as const satisfies readonly IssueWorkProductReviewState[];
export type DesignReviewState = (typeof DESIGN_REVIEW_STATES)[number];

export function isDesignReviewState(value: string): value is DesignReviewState {
  return (DESIGN_REVIEW_STATES as readonly string[]).includes(value);
}

// Allowed design-review transitions (D22 gate):
//   none               → needs_board_review
//   needs_board_review → approved | changes_requested
//   changes_requested  → needs_board_review   (resubmit after addressing feedback)
//   approved           → needs_board_review   (re-open the approved design for changes)
//   <any>              → itself               (no-op, always allowed)
// Everything else is invalid. Pure/idempotent: never throws — callers decide how
// to surface an invalid transition.
export function isValidDesignReviewTransition(from: string, to: string): boolean {
  if (from === to) return true;
  switch (from) {
    case "none":
      return to === "needs_board_review";
    case "needs_board_review":
      return to === "approved" || to === "changes_requested";
    case "changes_requested":
      return to === "needs_board_review";
    case "approved":
      return to === "needs_board_review";
    default:
      return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// WC-182f / D22: the design gate DRIVES development.
//
// When a dev/QA agent wakes on an issue, its context bundle must (a) surface the
// authoritative source-of-truth design as the thing to build against once it is
// approved, and (b) tell the agent to HOLD when a source-of-truth design exists
// but is not yet board-approved. This pure derivation turns the raw work-product
// list into that agent-facing signal. The agent context is English, so the
// directive copy is English.
//
// Pure & total: derived only from the passed work products; never throws.
// ───────────────────────────────────────────────────────────────────────────
export interface IssueDesignGateAuthoritative {
  id: string;
  title: string;
  url: string | null;
  reviewState: string;
}

export interface IssueDesignGate {
  // At least one design-type work product is attached to the issue.
  hasDesign: boolean;
  // The isPrimary design-type work product (the source of truth), or null.
  authoritativeDesign: IssueDesignGateAuthoritative | null;
  // The authoritative design's review gate is at "approved".
  approved: boolean;
  // A source-of-truth design exists but is not yet approved → hold development.
  developmentHold: boolean;
  // Agent-facing directive (English). Empty string when there are no designs.
  directive: string;
}

export function deriveIssueDesignGate(
  workProducts: IssueWorkProduct[],
  options?: { designRequired?: boolean },
): IssueDesignGate {
  // WC-195: when design is REQUIRED for this issue (the default unless the issue
  // is explicitly exempted), development also holds while NO approved design
  // exists — not just when an unapproved one is attached. Default false keeps
  // every existing caller byte-identical.
  const designRequired = options?.designRequired ?? false;

  const designs = workProducts.filter((wp) => isDesignWorkProductType(wp.type));
  const hasDesign = designs.length > 0;

  const primary = designs.find((wp) => wp.isPrimary === true) ?? null;
  const authoritativeDesign: IssueDesignGateAuthoritative | null = primary
    ? {
        id: primary.id,
        title: primary.title,
        url: primary.url ?? null,
        reviewState: primary.reviewState,
      }
    : null;

  const approved = authoritativeDesign?.reviewState === "approved";
  // (a) existing: a source-of-truth design exists but is not yet approved; OR
  // (b) WC-195: design is required and no approved design exists yet.
  const developmentHold = designRequired ? !approved : !!authoritativeDesign && !approved;

  let directive = "";
  if (authoritativeDesign) {
    const urlPart = authoritativeDesign.url ? ` (${authoritativeDesign.url})` : "";
    if (approved) {
      directive =
        `The approved source-of-truth design for this issue is ` +
        `"${authoritativeDesign.title}"${urlPart}. Build and verify against it; ` +
        `do not deviate from the design.`;
    } else {
      directive =
        `HOLD development: this issue has a source-of-truth design ` +
        `("${authoritativeDesign.title}") that is NOT yet board-approved ` +
        `(review state: ${authoritativeDesign.reviewState}). Wait for design ` +
        `approval before implementing; raise design concerns to the designer/board ` +
        `instead of building.`;
    }
  } else if (hasDesign) {
    directive =
      `Design artifacts exist but none is marked the source-of-truth design yet; ` +
      `designate and get one approved before building.`;
  } else if (designRequired) {
    // WC-195: required, but no design exists at all.
    directive =
      `HOLD development: a design is REQUIRED before work proceeds on this issue, ` +
      `and no design artifact exists yet. Create a design (시안), attach it as the ` +
      `source of truth, and get it board-approved first. If this is clearly ` +
      `non-screen (e.g. backend-only) work, mark it design-exempt via ` +
      `POST /issues/:id/design-requirement { "required": false, "reason": "..." }.`;
  }

  return { hasDesign, authoritativeDesign, approved, developmentHold, directive };
}

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function workProductService(db: Db) {
  const service = {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return rows.map(toIssueWorkProduct);
    },

    hasProofForIssue: async (issueId: string, companyId: string, dbOrTx: Db = db) =>
      dbOrTx
        .select({ id: issueWorkProducts.id })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.issueId, issueId),
            eq(issueWorkProducts.type, "proof"),
          ),
        )
        .limit(1)
        .then((r) => r.length > 0),

    // WC-187 / CP6: derive the issue's design gate from persisted work products,
    // scoped to company + issue, optionally inside a transaction (dbOrTx) so the
    // design-first Done gate can run beside the proof gate in issueService.update.
    // Reuses the pure deriveIssueDesignGate derivation (does not re-derive the
    // hold logic): we only need the design-type rows to feed it, so the query is
    // narrowed to design types. Idempotent: never throws on read.
    deriveDesignGateForIssue: async (
      issueId: string,
      companyId: string,
      dbOrTx: Db = db,
    ): Promise<IssueDesignGate> => {
      const rows = await dbOrTx
        .select()
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.issueId, issueId),
            inArray(issueWorkProducts.type, [...DESIGN_WORK_PRODUCT_TYPES]),
          ),
        );
      // WC-195: design is required when the issue's own override says so, else
      // the company-wide default. issues.design_requirement = { required:false }
      // exempts a specific issue (set manually or by an AI agent for obvious
      // non-screen work); companies.require_design_first is the company default
      // (off → design optional, byte-identical to pre-WC-195).
      const issueRow = await dbOrTx
        .select({ designRequirement: issues.designRequirement })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((r) => r[0] ?? null);
      const companyRow = await dbOrTx
        .select({ requireDesignFirst: companies.requireDesignFirst })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((r) => r[0] ?? null);
      const override = issueRow?.designRequirement as { required?: boolean } | null | undefined;
      const designRequired =
        typeof override?.required === "boolean"
          ? override.required
          : (companyRow?.requireDesignFirst ?? false);
      return deriveIssueDesignGate(rows.map(toIssueWorkProduct), { designRequired });
    },

    // WC-9: batch variant for the issue list — one query returns the Set of issue
    // IDs (within the given subset) that have at least one `type:"proof"` work
    // product. The list endpoint uses it to populate `Issue.hasProof` so the UI
    // can render a proof chip without an N+1 round trip per card.
    findIssueIdsWithProof: async (
      companyId: string,
      issueIds: string[],
      dbOrTx: Db = db,
    ): Promise<Set<string>> => {
      if (issueIds.length === 0) return new Set();
      const rows = await dbOrTx
        .select({ issueId: issueWorkProducts.issueId })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            inArray(issueWorkProducts.issueId, issueIds),
            eq(issueWorkProducts.type, "proof"),
          ),
        );
      return new Set(rows.map((row) => row.issueId));
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    // ───────────────────────────────────────────────────────────────────────
    // WC-182 / D22: source-of-truth design.
    // The isPrimary design-type work product on an issue IS that issue's
    // authoritative source-of-truth design; reviewState is its review gate.
    // QA/dev build against the approved authoritative design (design drives
    // implementation, not the reverse).
    // ───────────────────────────────────────────────────────────────────────

    // Read-only: the issue's authoritative source-of-truth design, i.e. the
    // isPrimary work product whose type is a design type, scoped to company +
    // issue. Returns null when the issue has no primary design. Idempotent:
    // never throws on read.
    getAuthoritativeDesignForIssue: async (
      issueId: string,
      companyId: string,
      dbOrTx: Db = db,
    ): Promise<IssueWorkProduct | null> => {
      const row = await dbOrTx
        .select()
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.issueId, issueId),
            eq(issueWorkProducts.isPrimary, true),
            inArray(issueWorkProducts.type, [...DESIGN_WORK_PRODUCT_TYPES]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    // Promote the given work product to be its issue's authoritative
    // (source-of-truth) design. Asserts the row exists and is a design type,
    // then reuses update({ isPrimary: true }) so per-type primary uniqueness is
    // preserved (any other primary design of the same type for the same issue is
    // unset). Company/issue scope is inherited from the row itself.
    setAuthoritativeDesign: async (id: string): Promise<IssueWorkProduct> => {
      const existing = await db
        .select({ type: issueWorkProducts.type })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) {
        throw new Error(`Work product ${id} not found`);
      }
      if (!isDesignWorkProductType(existing.type)) {
        throw new Error(
          `Work product ${id} has type "${existing.type}", which is not a design type ` +
            `(${DESIGN_WORK_PRODUCT_TYPES.join(", ")}); cannot set as authoritative design`,
        );
      }
      const updated = await service.update(id, { isPrimary: true });
      if (!updated) {
        // Row existed at read time; a concurrent delete is the only way here.
        throw new Error(`Work product ${id} not found`);
      }
      return updated;
    },

    // Advance the design-review gate for the issue's design work product.
    // Validates that nextState is a known design-review state and that the
    // current → next transition is allowed (see isValidDesignReviewTransition),
    // asserts the row exists and is a design type, then persists via
    // update({ reviewState }).
    setDesignReviewState: async (
      id: string,
      nextState: string,
    ): Promise<IssueWorkProduct> => {
      if (!isDesignReviewState(nextState)) {
        throw new Error(
          `Invalid design review state "${nextState}"; expected one of ` +
            `${DESIGN_REVIEW_STATES.join(", ")}`,
        );
      }
      const existing = await db
        .select({
          type: issueWorkProducts.type,
          reviewState: issueWorkProducts.reviewState,
        })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) {
        throw new Error(`Work product ${id} not found`);
      }
      if (!isDesignWorkProductType(existing.type)) {
        throw new Error(
          `Work product ${id} has type "${existing.type}", which is not a design type ` +
            `(${DESIGN_WORK_PRODUCT_TYPES.join(", ")}); cannot set its design review state`,
        );
      }
      if (!isValidDesignReviewTransition(existing.reviewState, nextState)) {
        throw new Error(
          `Invalid design review transition "${existing.reviewState}" → "${nextState}" ` +
            `for work product ${id}`,
        );
      }
      const updated = await service.update(id, { reviewState: nextState });
      if (!updated) {
        throw new Error(`Work product ${id} not found`);
      }
      // WC-194 (revises WC-192 per user direction — 이전 버전 삭제): approving a
      // design promotes it to the live source of truth, so its older same-type
      // siblings on the issue are superseded — HARD-DELETE them so the catalog
      // keeps exactly ONE current design per screen. Fires for ANY approver,
      // including the QA/board AGENT approving via the API. The design-spec
      // DOCUMENT and the just-approved design are separate and unaffected.
      if (nextState === "approved") {
        await service.autoDeleteSupersededDesigns(id);
      }
      return updated;
    },

    // WC-194: hard-delete a single design work product. Validates it is a design
    // type, then removes the row. Only superseded mockup rows go — the issue's
    // design-spec document and current authoritative design are separate.
    deleteDesign: async (id: string): Promise<void> => {
      const existing = await service.getById(id);
      if (!existing) throw new Error(`Work product ${id} not found`);
      if (!isDesignWorkProductType(existing.type)) {
        throw new Error(
          `Work product ${id} has type "${existing.type}", which is not a design type ` +
            `(${DESIGN_WORK_PRODUCT_TYPES.join(", ")}); refusing to delete via the design path`,
        );
      }
      await service.remove(id);
    },

    // When a design is approved as the new authoritative version, its older
    // same-type designs on the same issue are superseded → HARD-DELETE them.
    // Scoped to company + issue + type so unrelated design types (e.g. a
    // screenshot when a mockup is approved) are left untouched. Returns the ids
    // it deleted.
    autoDeleteSupersededDesigns: async (approvedId: string): Promise<string[]> => {
      const approved = await service.getById(approvedId);
      if (!approved || !isDesignWorkProductType(approved.type)) return [];
      const rows = await db
        .select({ id: issueWorkProducts.id })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, approved.companyId),
            eq(issueWorkProducts.issueId, approved.issueId),
            eq(issueWorkProducts.type, approved.type),
          ),
        );
      const deleted: string[] = [];
      for (const row of rows) {
        if (row.id === approvedId) continue;
        await service.remove(row.id);
        deleted.push(row.id);
      }
      return deleted;
    },

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) => {
      const row = await db.transaction(async (tx) => {
        if (data.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
              ),
            );
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            companyId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (id: string, patch: Partial<typeof issueWorkProducts.$inferInsert>) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
              ),
            );
        }

        return await tx
          .update(issueWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    remove: async (id: string) => {
      const row = await db
        .delete(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },
  };

  return service;
}

export { toIssueWorkProduct };
