// Design-system redesign — screens as first-class units.
//
// A "screen" is one canonical app page. ONE issue can hold MULTIPLE design
// artifacts, each representing a single screen (one screen per artifact). These
// pure helpers are the SINGLE source of truth — shared by the server (screen-
// scoped primary uniqueness, the all-screens-approved design gate) and the UI
// (per-screen catalog, flow dashboard) — so both agree on screen identity and
// grouping with no drift.
import {
  designLineageDisplayTitle,
  normalizeDesignLineageTitle,
} from "./design-lineage.js";
import type {
  IssueWorkProduct,
  IssueWorkProductReviewState,
} from "./types/work-product.js";

// Slugify a screen display name into a stable screen_key. Unicode-aware (keeps
// Korean letters), lowercases, collapses runs of non-alphanumerics to a single
// dash, trims dashes. Falls back to "screen" when nothing survives.
export function slugifyScreenKey(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "screen";
}

// Agents sometimes bake a VERSION / ISSUE-REF / STAGING marker into screen_key
// (e.g. "real-edu-home-lor476-v11", "...-home-v9") — which would split every
// revision of ONE screen into a SEPARATE screen, so old versions never group or
// supersede. Strip those trailing markers (repeatedly) so all revisions of a
// screen share ONE canonical key. Only TRAILING markers are removed, so a real
// key like "lesson-v2-quiz" (version mid-slug) is left intact.
const SCREEN_KEY_TRAILING_MARKERS = [
  /[-_ ]*v\d+(?:\.\d+)*$/i, //         -v11, -v2.1
  /[-_ ]*(?:lor|wc|pap)-?\d+$/i, //    -lor476, -wc12 (issue refs)
  /[-_ ]*(?:staging|stage|final|draft|wip)$/i,
];
export function canonicalScreenKey(key: string): string {
  let k = key.trim().toLowerCase();
  let prev = "";
  while (k !== prev && k.length > 0) {
    prev = k;
    for (const re of SCREEN_KEY_TRAILING_MARKERS) k = k.replace(re, "");
  }
  return k || key.trim().toLowerCase();
}

// The screen-grouping key for a work product: its explicit screen_key (canonical-
// ized so version/issue/staging suffixes don't fork a screen) when set, else its
// title's lineage key (back-compat — legacy rows with no screen_key keep grouping
// by de-versioned title, exactly as the old single-screen model).
export function effectiveScreenKey(wp: {
  screenKey?: string | null;
  title: string;
}): string {
  const explicit = wp.screenKey?.trim();
  if (explicit) return canonicalScreenKey(explicit);
  return normalizeDesignLineageTitle(wp.title);
}

// The display name for a screen: its explicit screen_name when set, else the
// de-versioned display title.
export function screenDisplayName(wp: {
  screenName?: string | null;
  title: string;
}): string {
  const explicit = wp.screenName?.trim();
  if (explicit) return explicit;
  return designLineageDisplayTitle(wp.title);
}

function updatedAtMillis(wp: IssueWorkProduct): number {
  const value = wp.updatedAt as unknown;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

export interface DesignScreenGroup {
  screenKey: string;
  screenName: string;
  // The current version of this screen within the grouped set: the isPrimary
  // one, else the most recently updated.
  current: IssueWorkProduct;
  // All versions of this screen, newest first.
  versions: IssueWorkProduct[];
  // current.reviewState === "approved".
  approved: boolean;
}

// Group a flat list of design-type work products into one entry per screen
// (keyed by effectiveScreenKey). For each screen the "current" version is the
// isPrimary one, falling back to the most recently updated. Pure & total: a
// screen with no isPrimary still yields a current; an empty input yields []. The
// returned groups are ordered by screen name for stable rendering.
export function groupDesignsByScreen(
  designs: IssueWorkProduct[],
): DesignScreenGroup[] {
  const byKey = new Map<string, IssueWorkProduct[]>();
  for (const wp of designs) {
    const key = effectiveScreenKey(wp);
    const arr = byKey.get(key);
    if (arr) arr.push(wp);
    else byKey.set(key, [wp]);
  }
  const groups: DesignScreenGroup[] = [];
  for (const [screenKey, items] of byKey) {
    const versions = [...items].sort((a, b) => updatedAtMillis(b) - updatedAtMillis(a));
    const current = versions.find((v) => v.isPrimary === true) ?? versions[0];
    groups.push({
      screenKey,
      screenName: screenDisplayName(current),
      current,
      versions,
      approved: current.reviewState === "approved",
    });
  }
  groups.sort((a, b) => a.screenName.localeCompare(b.screenName));
  return groups;
}

// ───────────────────────────────────────────────────────────────────────────
// Cross-screen navigation links (R3) + flow dashboard (R4) + guide (R1) shapes.
// ───────────────────────────────────────────────────────────────────────────

export type DesignScope =
  | { kind: "project"; projectId: string }
  | { kind: "company" };

export interface DesignScreenLink {
  id: string;
  companyId: string;
  projectId: string | null;
  fromScreenKey: string;
  toScreenKey: string;
  label: string;
  sourceWorkProductId: string | null;
  createdByKind: "agent" | "board" | string;
  createdAt: Date;
  updatedAt: Date;
}

// Screen form factor — drives how the flow renders the node frame (mobile portrait
// vs desktop landscape vs tablet), so a wide admin screen isn't squeezed into the
// same portrait box as a phone screen. Declared per 시안 at design_attach time.
export const DESIGN_FORM_FACTORS = ["mobile", "tablet", "desktop"] as const;
export type DesignFormFactor = (typeof DESIGN_FORM_FACTORS)[number];

// One node in the wireframe flow dashboard: a canonical app screen + a pointer
// to its current 시안 preview.
export interface DesignFlowScreen {
  screenKey: string;
  screenName: string;
  workProductId: string;
  issueId: string;
  previewUrl: string | null;
  reviewState: IssueWorkProductReviewState;
  approved: boolean;
  // R5: persisted canvas position (raw layout coords); null/absent → auto-layout
  // fallback. R4: pointer to the paired "화면 기획" (screen_plan) work product.
  // Optional so existing callers/fixtures compile; populated by getFlow (Slice 1+).
  x?: number | null;
  y?: number | null;
  planWorkProductId?: string | null;
  // Drives node frame size/aspect in the flow (default "mobile").
  formFactor?: DesignFormFactor | null;
}

export interface DesignFlow {
  scope: DesignScope;
  screens: DesignFlowScreen[];
  links: DesignScreenLink[];
}

// R3/R4: the paired "화면 기획" (screen plan) behind a pure-screen 시안 — the
// spec/plan text for one screen, read by the screen-plan detail page. Stored as a
// non-design 'screen_plan' work product, paired 1:1 to its mockup by screenKey.
export interface DesignScreenPlan {
  screenKey: string;
  screenName: string;
  planMarkdown: string;
  workProductId: string;
}

// A declared-but-target-not-yet-designed link still wants to render an edge to a
// stub node. Collect the set of screen keys referenced by links but absent from
// the screen list so the dashboard can show "planned" nodes.
export function danglingLinkTargets(flow: {
  screens: { screenKey: string }[];
  links: { fromScreenKey: string; toScreenKey: string }[];
}): string[] {
  const known = new Set(flow.screens.map((s) => s.screenKey));
  const missing = new Set<string>();
  for (const link of flow.links) {
    if (!known.has(link.fromScreenKey)) missing.add(link.fromScreenKey);
    if (!known.has(link.toScreenKey)) missing.add(link.toScreenKey);
  }
  return [...missing];
}

export interface DesignGuideTokens {
  colors: string[];
  fontFamilies: string[];
  fontSizes: string[];
  spacing: string[];
  components: string[];
}

export interface DesignGuide {
  scope: DesignScope;
  notesMarkdown: string;
  tokens: DesignGuideTokens;
  // UX/design PRINCIPLES detected in the approved 시안 (e.g. annotations like
  // "Peak-End Rule", "근접성", "Progressive Disclosure"). The "philosophy" layer
  // above the mechanical tokens — the board's notesMarkdown is the authored one.
  principles: string[];
  screenCount: number;
  updatedAt: Date | null;
}
