import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { designGuides } from "@workcell/db";
import type { DesignGuide, DesignGuideTokens, DesignScope } from "@workcell/shared";
import { designFlowService } from "./design-flow.js";
import { extractDesignSystem } from "./design-system.js";

// How many approved screens to scan for tokens per guide view (bounded so the
// auto-extraction stays cheap even for a large app).
const TOKEN_SCAN_CAP = 16;
const MAX_GUIDE_COLORS = 48;

// Curated UX/design PRINCIPLE terms. Workcell 시안 carry UX-pattern annotations
// (the LORO boards cite "Peak-End Rule", "Working Memory protection", "Gestalt
// Proximity", "Tesler's Law", "Progressive Disclosure", …). Surfacing the ones
// actually present in the approved screens gives the guide a "philosophy" layer
// above the mechanical color/spacing tokens. Matched case-insensitively against
// each screen's HTML; the display label is the canonical term below.
const PRINCIPLE_TERMS: string[] = [
  "Peak-End Rule", "Gestalt", "Proximity", "Progressive Disclosure", "Working Memory",
  "Tesler's Law", "Hick's Law", "Fitts's Law", "Miller's Law", "Jakob's Law",
  "Doherty Threshold", "Von Restorff", "Serial Position", "Aesthetic-Usability",
  "Cognitive Load", "Affordance", "Recognition over Recall", "Feedback Loop",
  "근접성", "일관성", "점진적 공개", "인지 부하", "행동 유도성", "심미적", "피드백", "정렬", "대비",
];

type ResolveHtml = (url: string | null, companyId: string) => Promise<string | null>;

function scopeFilter(scope: DesignScope) {
  return scope.kind === "project"
    ? eq(designGuides.projectId, scope.projectId)
    : isNull(designGuides.projectId);
}

// Design-system redesign (R1): the single "design system guide" per app =
// board-authored notes (design_guides table) LAYERED OVER design tokens that are
// auto-extracted on read from the app's APPROVED screens (extractDesignSystem
// over each screen's 시안 HTML, merged + deduped). Tokens are never stored — the
// guide stays a living document that tracks the approved designs.
export function designGuideService(db: Db) {
  const flow = designFlowService(db);

  const service = {
    getNotes: async (
      companyId: string,
      scope: DesignScope,
    ): Promise<{ notesMarkdown: string; updatedAt: Date | null }> => {
      const row = await db
        .select()
        .from(designGuides)
        .where(and(eq(designGuides.companyId, companyId), scopeFilter(scope)))
        .limit(1)
        .then((r) => r[0] ?? null);
      return { notesMarkdown: row?.notesMarkdown ?? "", updatedAt: row?.updatedAt ?? null };
    },

    updateNotes: async (
      companyId: string,
      scope: DesignScope,
      notesMarkdown: string,
      actor: { kind: string; id: string | null },
    ): Promise<{ notesMarkdown: string; updatedAt: Date | null }> => {
      const existing = await db
        .select({ id: designGuides.id })
        .from(designGuides)
        .where(and(eq(designGuides.companyId, companyId), scopeFilter(scope)))
        .limit(1)
        .then((r) => r[0] ?? null);
      const now = new Date();
      if (existing) {
        const [row] = await db
          .update(designGuides)
          .set({
            notesMarkdown,
            updatedByKind: actor.kind,
            updatedById: actor.id,
            updatedAt: now,
          })
          .where(eq(designGuides.id, existing.id))
          .returning();
        return { notesMarkdown: row.notesMarkdown, updatedAt: row.updatedAt };
      }
      const [row] = await db
        .insert(designGuides)
        .values({
          companyId,
          projectId: scope.kind === "project" ? scope.projectId : null,
          notesMarkdown,
          updatedByKind: actor.kind,
          updatedById: actor.id,
        })
        .returning();
      return { notesMarkdown: row.notesMarkdown, updatedAt: row.updatedAt };
    },

    // Auto-extract + merge tokens AND detect design principles from the scope's
    // APPROVED screens.
    aggregateTokens: async (
      companyId: string,
      scope: DesignScope,
      resolveHtml: ResolveHtml,
    ): Promise<{ tokens: DesignGuideTokens; principles: string[]; screenCount: number }> => {
      const flowData = await flow.getFlow(companyId, scope);
      const approved = flowData.screens.filter((s) => s.approved);
      const colors = new Set<string>();
      const fontFamilies = new Set<string>();
      const fontSizes = new Set<string>();
      const spacing = new Set<string>();
      const components = new Set<string>();
      const principles = new Set<string>();
      for (const screen of approved.slice(0, TOKEN_SCAN_CAP)) {
        const html = await resolveHtml(screen.previewUrl, companyId);
        if (!html) continue;
        const ds = extractDesignSystem(html);
        ds.colors.forEach((c) => colors.add(c.value));
        ds.fontFamilies.forEach((f) => fontFamilies.add(f));
        ds.fontSizes.forEach((s) => fontSizes.add(s));
        ds.spacing.forEach((s) => spacing.add(s));
        ds.componentCounts.forEach((c) => components.add(c.tag));
        const lower = html.toLowerCase();
        for (const term of PRINCIPLE_TERMS) {
          if (lower.includes(term.toLowerCase())) principles.add(term);
        }
        // R3: the screen's SPEC prose now lives in its paired "화면 기획"
        // (planMarkdown), not baked into the mockup HTML — scan it too so the
        // guide's principle layer doesn't empty out as designers move prose there.
        if (screen.planWorkProductId) {
          const plan = await flow.getScreenPlan(companyId, scope, screen.screenKey);
          const plower = plan?.planMarkdown?.toLowerCase();
          if (plower) {
            for (const term of PRINCIPLE_TERMS) {
              if (plower.includes(term.toLowerCase())) principles.add(term);
            }
          }
        }
      }
      return {
        tokens: {
          colors: [...colors].slice(0, MAX_GUIDE_COLORS),
          fontFamilies: [...fontFamilies],
          fontSizes: [...fontSizes],
          spacing: [...spacing],
          components: [...components],
        },
        principles: [...principles],
        screenCount: flowData.screens.length,
      };
    },

    getGuide: async (
      companyId: string,
      scope: DesignScope,
      resolveHtml: ResolveHtml,
    ): Promise<DesignGuide> => {
      const [notes, agg] = await Promise.all([
        service.getNotes(companyId, scope),
        service.aggregateTokens(companyId, scope, resolveHtml),
      ]);
      return {
        scope,
        notesMarkdown: notes.notesMarkdown,
        tokens: agg.tokens,
        principles: agg.principles,
        screenCount: agg.screenCount,
        updatedAt: notes.updatedAt,
      };
    },
  };

  return service;
}
