import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { designScreenLinks, designScreenPositions, issues, issueWorkProducts } from "@workcell/db";
import {
  canonicalScreenKey,
  DESIGN_WORK_PRODUCT_TYPES,
  effectiveScreenKey,
  groupDesignsByScreen,
  type DesignFlow,
  type DesignFlowScreen,
  type DesignScope,
  type DesignScreenLink,
  type DesignScreenPlan,
} from "@workcell/shared";
import { toIssueWorkProduct } from "./work-products.js";

// Issues in these states drop out of the live App Blueprint (the auto-composed
// 시안 / screen flow). Non-destructive: the design rows stay in the DB, so a
// screen reappears the moment its issue leaves the state (e.g. is unblocked or
// reopened). "blocked" = paused/uncertain; "cancelled" = no longer part of the app.
const BLUEPRINT_EXCLUDED_ISSUE_STATUSES = ["blocked", "cancelled"] as const;

// Normalize a screen key to its canonical grouping form (lowercased, trimmed) so
// agent-declared targets line up with effectiveScreenKey() used everywhere else.
function normScreenKey(key: string): string {
  return key.trim().toLowerCase();
}

type DesignScreenLinkRow = typeof designScreenLinks.$inferSelect;

function toDesignScreenLink(row: DesignScreenLinkRow): DesignScreenLink {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    fromScreenKey: row.fromScreenKey,
    toScreenKey: row.toScreenKey,
    label: row.label,
    sourceWorkProductId: row.sourceWorkProductId ?? null,
    createdByKind: row.createdByKind,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// A design scope resolves to a work-product / link filter: a project scope
// matches projectId = X; the company scope is the "default app" — project-less
// artifacts (projectId IS NULL), which is where the current LORO edu-app 시안
// live (project_id = NULL).
function scopeWorkProductFilter(scope: DesignScope) {
  return scope.kind === "project"
    ? eq(issueWorkProducts.projectId, scope.projectId)
    : isNull(issueWorkProducts.projectId);
}
function scopeLinkFilter(scope: DesignScope) {
  return scope.kind === "project"
    ? eq(designScreenLinks.projectId, scope.projectId)
    : isNull(designScreenLinks.projectId);
}
function scopePositionFilter(scope: DesignScope) {
  return scope.kind === "project"
    ? eq(designScreenPositions.projectId, scope.projectId)
    : isNull(designScreenPositions.projectId);
}

export function designFlowService(db: Db) {
  const service = {
    // Idempotently declare a set of outbound nav links FROM one screen (R3).
    // Self-links and blank targets are skipped; duplicates collapse via the
    // NULLS-NOT-DISTINCT unique index. Returns the number of new rows inserted.
    declareLinks: async (input: {
      companyId: string;
      projectId: string | null;
      fromScreenKey: string;
      sourceWorkProductId: string | null;
      createdByKind?: string;
      links: { label?: string | null; targetScreenKey: string }[];
    }): Promise<number> => {
      const from = normScreenKey(input.fromScreenKey);
      let inserted = 0;
      for (const link of input.links) {
        const to = normScreenKey(link.targetScreenKey ?? "");
        if (!to || to === from) continue;
        const result = await db
          .insert(designScreenLinks)
          .values({
            companyId: input.companyId,
            projectId: input.projectId ?? null,
            fromScreenKey: from,
            toScreenKey: to,
            label: (link.label ?? "").trim(),
            sourceWorkProductId: input.sourceWorkProductId ?? null,
            createdByKind: input.createdByKind ?? "agent",
          })
          .onConflictDoNothing()
          .returning({ id: designScreenLinks.id });
        if (result.length > 0) inserted += 1;
      }
      return inserted;
    },

    // Board-authored single link (created/edited in the flow dashboard).
    addLink: async (input: {
      companyId: string;
      projectId: string | null;
      fromScreenKey: string;
      toScreenKey: string;
      label?: string | null;
      createdByKind?: string;
    }): Promise<DesignScreenLink | null> => {
      const from = normScreenKey(input.fromScreenKey);
      const to = normScreenKey(input.toScreenKey);
      if (!from || !to || from === to) return null;
      const [row] = await db
        .insert(designScreenLinks)
        .values({
          companyId: input.companyId,
          projectId: input.projectId ?? null,
          fromScreenKey: from,
          toScreenKey: to,
          label: (input.label ?? "").trim(),
          createdByKind: input.createdByKind ?? "board",
        })
        .onConflictDoNothing()
        .returning();
      if (row) return toDesignScreenLink(row);
      // Already existed (unique conflict) — return the existing row.
      const existing = await db
        .select()
        .from(designScreenLinks)
        .where(
          and(
            eq(designScreenLinks.companyId, input.companyId),
            input.projectId
              ? eq(designScreenLinks.projectId, input.projectId)
              : isNull(designScreenLinks.projectId),
            eq(designScreenLinks.fromScreenKey, from),
            eq(designScreenLinks.toScreenKey, to),
            eq(designScreenLinks.label, (input.label ?? "").trim()),
          ),
        )
        .limit(1)
        .then((r) => r[0] ?? null);
      return existing ? toDesignScreenLink(existing) : null;
    },

    removeLink: async (id: string, companyId: string): Promise<boolean> => {
      const rows = await db
        .delete(designScreenLinks)
        .where(and(eq(designScreenLinks.id, id), eq(designScreenLinks.companyId, companyId)))
        .returning({ id: designScreenLinks.id });
      return rows.length > 0;
    },

    listLinks: async (companyId: string, scope: DesignScope): Promise<DesignScreenLink[]> => {
      const rows = await db
        .select()
        .from(designScreenLinks)
        .where(and(eq(designScreenLinks.companyId, companyId), scopeLinkFilter(scope)))
        .orderBy(desc(designScreenLinks.createdAt));
      return rows.map(toDesignScreenLink);
    },

    // R5: persist a screen's canvas position (drag-to-reposition). Keyed by the
    // STABLE screen_key the flow node carries (getFlow emits group.screenKey and
    // the UI drags that exact key back) — stored VERBATIM so it round-trips and
    // re-attaches to the rendered node; NOT re-canonicalized (a legacy node's key
    // is a title-lineage key, not canonicalScreenKey output). Survives version
    // supersession because it keys off screen_key, not the volatile work-product
    // id. Upsert: re-dragging updates in place.
    setPosition: async (input: {
      companyId: string;
      projectId: string | null;
      screenKey: string;
      x: number;
      y: number;
      updatedByKind?: string | null;
      updatedById?: string | null;
    }): Promise<{ screenKey: string; x: number; y: number }> => {
      const screenKey = input.screenKey.trim();
      await db
        .insert(designScreenPositions)
        .values({
          companyId: input.companyId,
          projectId: input.projectId ?? null,
          screenKey,
          x: input.x,
          y: input.y,
          updatedByKind: input.updatedByKind ?? null,
          updatedById: input.updatedById ?? null,
        })
        .onConflictDoUpdate({
          target: [
            designScreenPositions.companyId,
            designScreenPositions.projectId,
            designScreenPositions.screenKey,
          ],
          set: {
            x: input.x,
            y: input.y,
            updatedByKind: input.updatedByKind ?? null,
            updatedById: input.updatedById ?? null,
            updatedAt: new Date(),
          },
        });
      return { screenKey, x: input.x, y: input.y };
    },

    listPositions: async (
      companyId: string,
      scope: DesignScope,
    ): Promise<{ screenKey: string; x: number; y: number }[]> => {
      const rows = await db
        .select()
        .from(designScreenPositions)
        .where(and(eq(designScreenPositions.companyId, companyId), scopePositionFilter(scope)));
      return rows.map((r) => ({ screenKey: r.screenKey, x: r.x, y: r.y }));
    },

    // The wireframe flow dashboard payload (R4): every canonical screen in the
    // scope + every nav link. Screens are derived from design work products
    // (grouped to one current version per screen), so they reflect live data.
    getFlow: async (companyId: string, scope: DesignScope): Promise<DesignFlow> => {
      const [productRows, links, positions, planRows, excludedIssueRows] = await Promise.all([
        db
          .select()
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.companyId, companyId),
              scopeWorkProductFilter(scope),
              inArray(issueWorkProducts.type, [...DESIGN_WORK_PRODUCT_TYPES]),
            ),
          ),
        service.listLinks(companyId, scope),
        service.listPositions(companyId, scope),
        // R4: paired screen plans in scope — pointer only (id), matched to a node
        // by canonical screen_key. screen_plan is NOT a design type, so it is
        // never grouped as a screen node above.
        db
          .select({
            id: issueWorkProducts.id,
            screenKey: issueWorkProducts.screenKey,
            title: issueWorkProducts.title,
          })
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.companyId, companyId),
              scopeWorkProductFilter(scope),
              eq(issueWorkProducts.type, "screen_plan"),
            ),
          ),
        // Issues currently blocked/cancelled — their 시안 are filtered out below so
        // the blueprint reflects only the live, active app surface.
        db
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              inArray(issues.status, [...BLUEPRINT_EXCLUDED_ISSUE_STATUSES]),
            ),
          ),
      ]);
      // R5: merge persisted positions onto nodes by screen_key (verbatim — the
      // same key getFlow emits and the UI drags back). Unpositioned screens get
      // x/y = null → the client auto-lays them out.
      const posByKey = new Map(positions.map((p) => [p.screenKey, p]));
      // R4: map each screen's plan (by canonical screen_key) so a node can link to
      // its "화면 기획" detail.
      const planByKey = new Map(
        planRows.map((p) => [effectiveScreenKey({ screenKey: p.screenKey, title: p.title }), p.id]),
      );
      // Drop 시안 owned by a blocked/cancelled issue so the blueprint shows the
      // live, active app surface. Read-time filter only — auto-restores when the
      // owning issue's status changes (the DB rows are never touched).
      const excludedIssueIds = new Set(excludedIssueRows.map((row) => row.id));
      const visibleProducts = productRows.filter(
        (row) => !row.issueId || !excludedIssueIds.has(row.issueId),
      );
      const groups = groupDesignsByScreen(visibleProducts.map(toIssueWorkProduct));
      const screens: DesignFlowScreen[] = groups.map((g) => {
        const pos = posByKey.get(g.screenKey);
        return {
          screenKey: g.screenKey,
          screenName: g.screenName,
          workProductId: g.current.id,
          issueId: g.current.issueId,
          previewUrl: g.current.url ?? null,
          reviewState: g.current.reviewState,
          approved: g.approved,
          x: pos ? pos.x : null,
          y: pos ? pos.y : null,
          planWorkProductId: planByKey.get(g.screenKey) ?? null,
          formFactor: (g.current.formFactor as DesignFlowScreen["formFactor"]) ?? null,
        };
      });
      return { scope, screens, links };
    },

    // R4: read one screen's paired "화면 기획" (screen plan) by scope + screen key
    // (the node's own key). Returns null when no plan exists yet — the detail page
    // shows a "no plan yet — re-run the designer" empty state for legacy screens.
    getScreenPlan: async (
      companyId: string,
      scope: DesignScope,
      screenKey: string,
    ): Promise<DesignScreenPlan | null> => {
      const key = canonicalScreenKey(screenKey);
      if (!key) return null;
      const row = await db
        .select({
          id: issueWorkProducts.id,
          screenKey: issueWorkProducts.screenKey,
          screenName: issueWorkProducts.screenName,
          title: issueWorkProducts.title,
          planMarkdown: issueWorkProducts.planMarkdown,
        })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            scopeWorkProductFilter(scope),
            eq(issueWorkProducts.type, "screen_plan"),
            eq(issueWorkProducts.screenKey, key),
          ),
        )
        .limit(1)
        .then((r) => r[0] ?? null);
      if (!row) return null;
      return {
        screenKey: row.screenKey ?? key,
        screenName: row.screenName ?? row.title,
        planMarkdown: row.planMarkdown ?? "",
        workProductId: row.id,
      };
    },
  };

  return service;
}
