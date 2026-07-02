import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { approvals, issueApprovals, issueWorkProducts, issues, companies } from "@workcell/db";
import type {
  DesignScreenGroup,
  IssueWorkProduct,
  IssueWorkProductReviewState,
} from "@workcell/shared";
import {
  canonicalScreenKey,
  effectiveScreenKey,
  groupDesignsByScreen,
} from "@workcell/shared";
import {
  DESIGN_WORK_PRODUCT_TYPES,
  isDesignWorkProductType,
} from "./design-artifact-types.js";
import { designWorkProductIdsApprovedByBoardApproval } from "./design-approval-signals.js";

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

// A 시안 attached via design_attach is stored as a data:text/html URL holding
// the ENTIRE mockup — often hundreds of KB. Such a url must NEVER be inlined
// into an agent prompt: it blows past the model's context window (a real
// failure traced to a 419KB task prompt whose "Design directive:" was a 413KB
// data: URL, looping codex/claude on "ran out of room" even on a fresh thread).
// Omit inline/oversized urls from prompt text; the agent opens the design via
// the work-products API / preview instead. Exported so every prompt builder
// (heartbeat directives included) uses the same guard.
export function promptSafeDesignUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("data:") || url.length > 300) return null;
  return url;
}

// WC-201: company-wide require_design_first should only HOLD an issue that
// plausibly involves UI/screen work. A pure, exported keyword heuristic over the
// issue's title+description (KR+EN, case-insensitive). Allocation-light: the
// keyword set is a module constant and the haystack is lowercased once.
//
// TRADEOFF: a genuine UI issue whose title/description contains NONE of these
// terms is auto-skipped (treated as non-UI → no hold). The escape hatch is the
// explicit per-issue override (POST /issues/:id/design-requirement {required:true}),
// which short-circuits this heuristic entirely in deriveDesignGateForIssue (the
// `typeof override?.required === "boolean"` branch).
// English keywords match on WORD BOUNDARIES (+ optional plural "s") — a bare
// substring would false-fire on common words ("ui" inside "build"/"require",
// "view" inside "review", "form" inside "perform"). Korean keywords match by
// substring (the language is agglutinative, so boundary matching is wrong).
const UI_WORK_KEYWORDS_EN = [
  "screen", "page", "ui", "ux", "button", "component", "layout", "design",
  "mockup", "wireframe", "css", "style", "form", "modal", "view", "dashboard",
  "nav", "icon", "color", "colour", "font", "responsive", "frontend", "theme",
] as const;
const UI_WORK_KEYWORDS_KO = [
  "화면", "화면설계", "페이지", "버튼", "컴포넌트", "레이아웃", "디자인", "시안",
  "스타일", "폼", "모달", "뷰", "대시보드", "네비", "아이콘", "색상", "컬러",
  "폰트", "반응형", "프론트", "프론트엔드", "스크린", "와이어프레임", "테마",
] as const;
const UI_WORK_EN_RE = new RegExp(`\\b(?:${UI_WORK_KEYWORDS_EN.join("|")})s?\\b`, "i");
// Strong operational-unblock signals must win over incidental UI words in the
// description, e.g. "unblock a design task by clearing a stale checkout lock".
// Avoid bare "checkout" so checkout-page UI work still stays design-first.
const OPERATIONAL_UNBLOCK_EN_RE =
  /\b(?:stale\s+checkout|checkout[-\s]?lock|run[-\s]?lock|execution[-\s]?lock|run\s+ownership\s+conflict|ownership\s+conflict|ops?\s+unblock|infra(?:structure)?\s+unblock|unblock(?:ing)?\s+(?:checkout|run|lock|execution|agent|designer|ownership)|(?:checkout|run[-\s]?lock|execution[-\s]?lock)\s+cleanup)\b/i;
const OPERATIONAL_UNBLOCK_KEYWORDS_KO = [
  "운영 차단 해소", "운영 unblock", "인프라 unblock", "런락", "런 lock",
  "체크아웃 정리", "checkout 정리", "체크아웃 락", "checkout 락",
  "실행 락", "실행 잠금", "소유권 충돌",
] as const;
const PLATFORM_DESIGN_GATE_EN_RE =
  /\b(?:design[-\s]?first|design[-\s]?gate|design[-\s]?request|screenkey|approval\/design[-\s]?gate)\b/i;
const PLATFORM_LOGIC_EN_RE =
  /\b(?:regression|server|backend|gate\s+logic|projection|dedup(?:e|lication)?|duplicate|recursion|recursive|inherit(?:ance)?|carry[-\s]?over|reuse)\b/i;
const PLATFORM_DESIGN_GATE_KEYWORDS_KO = [
  "design gate", "design-request", "screenKey", "시안 자동 승계", "승인된 동일 screenKey",
] as const;
const PLATFORM_LOGIC_KEYWORDS_KO = [
  "서버", "백엔드", "gate 로직", "게이트 로직", "회귀", "중복", "재귀", "승계", "재사용",
] as const;

function isLikelyOperationalUnblockWork(haystack: string): boolean {
  if (OPERATIONAL_UNBLOCK_EN_RE.test(haystack)) return true;
  return OPERATIONAL_UNBLOCK_KEYWORDS_KO.some((kw) => haystack.includes(kw));
}

function isLikelyPlatformDesignGateLogicWork(haystack: string): boolean {
  const hasDesignGateSignal =
    PLATFORM_DESIGN_GATE_EN_RE.test(haystack) ||
    PLATFORM_DESIGN_GATE_KEYWORDS_KO.some((kw) => haystack.includes(kw));
  if (!hasDesignGateSignal) return false;
  return (
    PLATFORM_LOGIC_EN_RE.test(haystack) ||
    PLATFORM_LOGIC_KEYWORDS_KO.some((kw) => haystack.includes(kw))
  );
}

export function isLikelyUiWork(issue: {
  title: string;
  description?: string | null;
  labels?: string[];
}): boolean {
  const haystack = [issue.title, issue.description ?? "", ...(issue.labels ?? [])].join(" ");
  if (isLikelyOperationalUnblockWork(haystack)) return false;
  if (isLikelyPlatformDesignGateLogicWork(haystack)) return false;
  if (UI_WORK_EN_RE.test(haystack)) return true;
  return UI_WORK_KEYWORDS_KO.some((kw) => haystack.includes(kw));
}

function extractExplicitScreenKeys(issue: {
  title?: string | null;
  description?: string | null;
}): Set<string> {
  const screenKeys = new Set<string>();
  const text = [issue.title ?? "", issue.description ?? ""].join("\n");
  const patterns = [
    /\bscreen[_-]?key\s*[:=]\s*`?([A-Za-z0-9][A-Za-z0-9._:-]{0,199})`?/gi,
    /\bscreen[_-]?key\s+`([^`]{1,200})`/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const key = canonicalScreenKey(match[1] ?? "");
      if (key) screenKeys.add(key);
    }
  }
  for (const match of text.matchAll(/`([a-z0-9][a-z0-9-]{1,199})`/g)) {
    const raw = match[1] ?? "";
    if (!raw.includes("-")) continue;
    if (/^(?:lor|wc|pap)-\d+$/i.test(raw)) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) continue;
    const key = canonicalScreenKey(raw);
    if (key) screenKeys.add(key);
  }
  return screenKeys;
}

// One screen's current state in the design gate. With the screens-first model an
// issue can carry MANY screens; the gate releases only when EVERY screen's
// current version is approved (R3 board decision: 전 화면 승인).
export interface IssueDesignGateScreen {
  screenKey: string;
  screenName: string;
  workProductId: string;
  url: string | null;
  reviewState: string;
  approved: boolean;
}

export interface IssueDesignGate {
  // At least one design-type work product is attached to the issue.
  hasDesign: boolean;
  // Back-compat: a single "authoritative" design — the current version of the
  // first screen (isPrimary preferred). Multi-screen callers should read
  // `screens` instead. Null when the issue has no design.
  authoritativeDesign: IssueDesignGateAuthoritative | null;
  // ALL screens' current versions are approved (single-screen issues: identical
  // to the old "the authoritative design is approved").
  approved: boolean;
  // Development holds (an unapproved screen exists, or a required design is
  // missing/incomplete).
  developmentHold: boolean;
  // Agent-facing directive (English). Empty string when there are no designs.
  directive: string;
  // Per-screen breakdown, one entry per canonical screen on the issue.
  screens: IssueDesignGateScreen[];
}

export function deriveIssueDesignGate(
  workProducts: IssueWorkProduct[],
  options?: { designRequired?: boolean; designExempt?: boolean },
): IssueDesignGate {
  // WC-195: when design is REQUIRED for this issue (the default unless the issue
  // is explicitly exempted), development also holds while NOT every screen is
  // approved — not just when an unapproved one is attached. Default false keeps
  // every existing caller byte-identical.
  const designRequired = options?.designRequired ?? false;
  // The issue was EXPLICITLY marked design-exempt (designRequirement.required
  // === false), not merely defaulted by a company that isn't design-first.
  // Exemption is the user's decision that this is not screen work, and it must
  // win over a stray unapproved 시안 that happens to be attached — otherwise a
  // backend issue someone exempted never runs (and never reaches Done) just
  // because an old/aspirational design sits on it. We can't distinguish this
  // from "designRequired=false" alone, so callers pass it separately.
  const designExempt = options?.designExempt ?? false;

  const designs = workProducts.filter((wp) => isDesignWorkProductType(wp.type));
  const hasDesign = designs.length > 0;

  // Group the issue's design artifacts into one entry per canonical screen, each
  // with its current version. One issue → many screens (R5); the same screen's
  // older versions are folded into `versions` (R2).
  const groups = groupDesignsByScreen(designs);
  const screens: IssueDesignGateScreen[] = groups.map((g) => ({
    screenKey: g.screenKey,
    screenName: g.screenName,
    workProductId: g.current.id,
    url: g.current.url ?? null,
    reviewState: g.current.reviewState,
    approved: g.approved,
  }));

  // Back-compat single design = the isPrimary screen's current (null when no
  // screen has an explicitly-primary current — preserves the old "designs
  // present but none designated → authoritativeDesign null" contract).
  const primaryGroup = groups.find((g) => g.current.isPrimary === true) ?? null;
  const authoritativeDesign: IssueDesignGateAuthoritative | null = primaryGroup
    ? {
        id: primaryGroup.current.id,
        title: primaryGroup.current.title,
        url: primaryGroup.current.url ?? null,
        reviewState: primaryGroup.current.reviewState,
      }
    : null;

  // EVERY screen approved ⇒ the issue's design is approved (R3: 전 화면 승인).
  const approved = screens.length > 0 && screens.every((s) => s.approved);
  const unapprovedScreens = screens.filter((s) => !s.approved);
  // A screen whose current version is explicitly primary but not approved.
  const hasUnapprovedPrimary = groups.some(
    (g) => g.current.isPrimary === true && !g.approved,
  );
  // An exempt issue never holds. Otherwise: (a) required ⇒ hold until EVERY
  // screen is approved (incl. when none exist yet); (b) optional ⇒ hold only
  // while an explicitly-designated (primary) screen is unapproved — a stray
  // unapproved draft on a non-design-first issue must not freeze it.
  const developmentHold = designExempt
    ? false
    : designRequired
      ? !approved
      : hasUnapprovedPrimary;

  let directive = "";
  if (hasDesign && approved) {
    // Every screen approved → list them all as the implementation targets.
    const list = screens
      .map((s) => {
        const safeUrl = promptSafeDesignUrl(s.url);
        return `"${s.screenName}"${safeUrl ? ` (${safeUrl})` : ""}`;
      })
      .join(", ");
    directive =
      `The approved source-of-truth design${screens.length > 1 ? "s" : ""} for this ` +
      `issue: ${list}. Build and verify against ${screens.length > 1 ? "them" : "it"}; ` +
      `do not deviate from the design. ${screens.length > 1 ? "Each is" : "It is"} the ` +
      `implementation target — follow ${screens.length > 1 ? "them" : "it"} exactly, and ` +
      `QA verifies the result against ${screens.length > 1 ? "these designs" : "this design"}. ` +
      `Keep any additional UI consistent with the project's design system.`;
  } else if (designExempt) {
    // Exempt + not all approved → no directive: proceed as ordinary work.
    directive = "";
  } else if (developmentHold && unapprovedScreens.length > 0) {
    const names = unapprovedScreens
      .map((s) => `"${s.screenName}" (${s.reviewState})`)
      .join(", ");
    directive =
      `HOLD development: ${unapprovedScreens.length} screen${unapprovedScreens.length > 1 ? "s are" : " is"} ` +
      `NOT yet board-approved on this issue: ${names}. Development releases only when ` +
      `EVERY screen of this issue is approved. Wait for design approval before ` +
      `implementing; raise design concerns to the designer/board instead of building.`;
  } else if (hasDesign && unapprovedScreens.length > 0) {
    // Designs exist but none is the designated source of truth (optional issue) —
    // informative, NON-holding: nudge toward approving each screen.
    directive =
      `Design artifacts exist for ${screens.length} screen${screens.length > 1 ? "s" : ""} ` +
      `but are not all board-approved yet; get each screen's 시안 approved (mark it the ` +
      `source of truth) to lock the design before building.`;
  } else if (designRequired) {
    // WC-195: required, but no design exists at all.
    directive =
      `HOLD development: a design is REQUIRED before work proceeds on this issue, ` +
      `and no design artifact exists yet. Produce high-quality 시안 first — ONE screen ` +
      `per design_attach call: identify each distinct app page this issue needs and ` +
      `attach them one at a time (set a STABLE screenKey per screen — the SAME slug ` +
      `for every revision of that screen, e.g. "learner-home"; never put the version/` +
      `issue id in screenKey or each version forks into a separate screen — plus ` +
      `screenName, and declare ` +
      `navigation between screens via the links field, e.g. a button on screen A that ` +
      `opens screen B). Review the project's existing approved designs and design-system ` +
      `tokens (color/type/spacing scale) and build FROM them; deliver each as a ` +
      `self-contained HTML/CSS mockup via design_attach (html mode) — the 시안 HTML is ` +
      `the PURE rendered screen, and the screen's SPEC (purpose, states like ` +
      `empty/loading/error, interactions, data) goes in design_attach's planMarkdown, ` +
      `the paired "화면 기획" — NOT baked into the mockup. CRITICAL: the board ` +
      `previews your 시안 in a SANDBOXED iframe with JavaScript DISABLED — render ALL ` +
      `content with STATIC HTML/CSS. Do NOT rely on JS to build the screen (any ` +
      `JS-generated content — lists, paths, charts — shows EMPTY to the board); if you ` +
      `use JS at all, include a static no-script fallback that renders the full screen. ` +
      `When you attach a 시안, ` +
      `Workcell RENDERS it to a screenshot and re-wakes you with that PNG as image input ` +
      `— review the rendered pixels against the visual quality bar and the design-system ` +
      `tokens, revise and re-attach if it falls short, and submit for board review only ` +
      `when it clears the bar (visual self-review is capped at 3 rounds). Do not submit ` +
      `HTML you have not seen; an obviously-empty 시안 (no colors/font sizes) is also ` +
      `rejected at submit. Do NOT pack multiple screens into one 시안. If this is clearly ` +
      `non-screen (e.g. backend-only) work, mark it design-exempt via ` +
      `POST /issues/:id/design-requirement { "required": false, "reason": "..." }.`;
  }

  return { hasDesign, authoritativeDesign, approved, developmentHold, directive, screens };
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
    screenKey: row.screenKey ?? null,
    screenName: row.screenName ?? null,
    formFactor: row.formFactor ?? null,
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

// The transaction handle drizzle hands to db.transaction(cb) — structurally a Db
// minus $client; helpers that run inside a tx accept either.
type WorkProductDbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function applyBoardApprovedDesignSignals(
  workProducts: IssueWorkProduct[],
  approvalPayloads: Array<Record<string, unknown>>,
): IssueWorkProduct[] {
  const approvalApprovedIds = designWorkProductIdsApprovedByBoardApproval(workProducts, approvalPayloads);
  if (approvalApprovedIds.size === 0) return workProducts;
  return workProducts.map((wp) =>
    approvalApprovedIds.has(wp.id) && wp.reviewState === "needs_board_review"
      ? { ...wp, reviewState: "approved" as const }
      : wp,
  );
}

async function readDesignGateWorkProducts(
  dbOrTx: WorkProductDbOrTx,
  companyId: string,
  designIssueIds: string[],
): Promise<IssueWorkProduct[]> {
  if (designIssueIds.length === 0) return [];
  const [rows, approvedDesignApprovalRows] = await Promise.all([
    dbOrTx
      .select()
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, companyId),
          inArray(issueWorkProducts.issueId, designIssueIds),
          inArray(issueWorkProducts.type, [...DESIGN_WORK_PRODUCT_TYPES]),
        ),
      ),
    dbOrTx
      .select({ payload: approvals.payload })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(
        and(
          eq(issueApprovals.companyId, companyId),
          inArray(issueApprovals.issueId, designIssueIds),
          eq(approvals.companyId, companyId),
          eq(approvals.type, "request_board_approval"),
          eq(approvals.status, "approved"),
        ),
      ),
  ]);
  return applyBoardApprovedDesignSignals(
    rows.map(toIssueWorkProduct),
    approvedDesignApprovalRows.map((row) => row.payload),
  );
}

async function findDesignReuseAncestorIssueIds(
  dbOrTx: WorkProductDbOrTx,
  companyId: string,
  startingParentId: string | null | undefined,
): Promise<string[]> {
  const ancestorIds: string[] = [];
  const seen = new Set<string>();
  let parentId = startingParentId ?? null;

  for (let depth = 0; parentId && depth < 12; depth += 1) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = await dbOrTx
      .select({
        id: issues.id,
        parentId: issues.parentId,
        originKind: issues.originKind,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.id, parentId),
          isNull(issues.hiddenAt),
          ne(issues.status, "cancelled"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!parent) break;
    if (parent.originKind !== "design_request") ancestorIds.push(parent.id);
    parentId = parent.parentId ?? null;
  }

  return ancestorIds;
}

async function findDesignRequestChildIds(
  dbOrTx: WorkProductDbOrTx,
  companyId: string,
  originIssueIds: string[],
): Promise<string[]> {
  if (originIssueIds.length === 0) return [];
  const rows = await dbOrTx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, "design_request"),
        inArray(issues.originId, originIssueIds),
        isNull(issues.hiddenAt),
        ne(issues.status, "cancelled"),
      ),
    );
  return rows.map((row) => row.id);
}

async function readApprovedInheritedDesigns(input: {
  dbOrTx: WorkProductDbOrTx;
  companyId: string;
  parentId: string | null | undefined;
  targetScreenKeys?: Set<string>;
}): Promise<IssueWorkProduct[]> {
  const ancestorIssueIds = await findDesignReuseAncestorIssueIds(input.dbOrTx, input.companyId, input.parentId);
  if (ancestorIssueIds.length === 0) return [];
  const ancestorDesignRequestChildIds = await findDesignRequestChildIds(
    input.dbOrTx,
    input.companyId,
    ancestorIssueIds,
  );
  const ancestorWorkProducts = await readDesignGateWorkProducts(input.dbOrTx, input.companyId, [
    ...ancestorIssueIds,
    ...ancestorDesignRequestChildIds,
  ]);

  const approvedSourceRows = ancestorWorkProducts.filter(
    (wp) =>
      wp.isPrimary === true &&
      wp.reviewState === "approved",
  );
  if (approvedSourceRows.length === 0) return [];

  const approvedGate = deriveIssueDesignGate(approvedSourceRows);
  const targetScreenKeys = input.targetScreenKeys ?? new Set<string>();
  const reusableScreens =
    targetScreenKeys.size > 0
      ? approvedGate.screens.filter((screen) => targetScreenKeys.has(screen.screenKey))
      : approvedGate.screens.length === 1
        ? approvedGate.screens
        : [];
  const currentApprovedIds = new Set(reusableScreens.map((screen) => screen.workProductId));
  return approvedSourceRows.filter((wp) => currentApprovedIds.has(wp.id));
}

function inheritedDesignsCoverCurrentScreens(
  currentGate: IssueDesignGate,
  inheritedGate: IssueDesignGate,
): boolean {
  if (!inheritedGate.approved || inheritedGate.screens.length === 0) return false;
  if (currentGate.screens.length === 0) return true;
  const inheritedScreenKeys = new Set(inheritedGate.screens.map((screen) => screen.screenKey));
  return currentGate.screens.every((screen) => inheritedScreenKeys.has(screen.screenKey));
}

// When a work product is promoted to isPrimary, its same-"slot" siblings on the
// issue lose primary so exactly one current remains per slot. For DESIGN types
// the slot is the SCREEN (effectiveScreenKey) — a different screen on the same
// issue keeps its own current (one issue → many screens). For non-design types
// the slot stays the legacy per-`type` uniqueness. Runs inside the caller's tx.
async function demotePrimarySiblings(
  tx: WorkProductDbOrTx,
  args: {
    companyId: string;
    issueId: string;
    type: string;
    screenKey: string | null;
    title: string;
    exceptId: string | null;
  },
): Promise<void> {
  const now = new Date();
  if (isDesignWorkProductType(args.type)) {
    const targetKey = effectiveScreenKey({ screenKey: args.screenKey, title: args.title });
    const rows = await tx
      .select({
        id: issueWorkProducts.id,
        screenKey: issueWorkProducts.screenKey,
        title: issueWorkProducts.title,
      })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, args.companyId),
          eq(issueWorkProducts.issueId, args.issueId),
          eq(issueWorkProducts.isPrimary, true),
          inArray(issueWorkProducts.type, [...DESIGN_WORK_PRODUCT_TYPES]),
        ),
      );
    const ids = rows
      .filter((r) => r.id !== args.exceptId && effectiveScreenKey(r) === targetKey)
      .map((r) => r.id);
    if (ids.length > 0) {
      await tx
        .update(issueWorkProducts)
        .set({ isPrimary: false, updatedAt: now })
        .where(inArray(issueWorkProducts.id, ids));
    }
    return;
  }
  const conds = [
    eq(issueWorkProducts.companyId, args.companyId),
    eq(issueWorkProducts.issueId, args.issueId),
    eq(issueWorkProducts.type, args.type),
  ];
  if (args.exceptId) conds.push(ne(issueWorkProducts.id, args.exceptId));
  await tx
    .update(issueWorkProducts)
    .set({ isPrimary: false, updatedAt: now })
    .where(and(...conds));
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
      // Read issue policy and design-request children first. Historically some
      // design_request children ended up carrying the 시안 themselves; the parent
      // gate still has to see those child designs or it will create the same
      // request again after the child completes.
      const [issueRow, companyRow, designRequestChildren] = await Promise.all([
        // WC-195: design is required when the issue's own override says so, else
        // the company-wide default. issues.design_requirement = { required:false }
        // exempts a specific issue (set manually or by an AI agent for obvious
        // non-screen work); companies.require_design_first is the company default
        // (off → design optional, byte-identical to pre-WC-195).
        dbOrTx
          .select({
            designRequirement: issues.designRequirement,
            parentId: issues.parentId,
            originKind: issues.originKind,
            title: issues.title,
            description: issues.description,
          })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((r) => r[0] ?? null),
        dbOrTx
          .select({ requireDesignFirst: companies.requireDesignFirst })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((r) => r[0] ?? null),
        dbOrTx
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.originKind, "design_request"),
              eq(issues.originId, issueId),
              isNull(issues.hiddenAt),
              ne(issues.status, "cancelled"),
            ),
          ),
      ]);
      const designIssueIds = [issueId, ...designRequestChildren.map((child) => child.id)];
      const workProducts = await readDesignGateWorkProducts(dbOrTx, companyId, designIssueIds);
      const override = issueRow?.designRequirement as { required?: boolean } | null | undefined;
      // EXPLICIT exemption (override says required:false) vs merely defaulting to
      // optional because the company isn't design-first — only the former should
      // override a stray unapproved 시안 (see deriveIssueDesignGate.designExempt).
      const designExempt = override?.required === false;
      let designRequired: boolean;
      if (typeof override?.required === "boolean") {
        // Explicit per-issue override ALWAYS wins (required:true holds, required:false exempts).
        designRequired = override.required;
      } else {
        // WC-201: company-wide require_design_first only holds an issue that
        // PLAUSIBLY involves UI/screen work. A company-default issue with no UI
        // signal is treated as not-required (auto-skip) instead of held forever
        // behind a 시안 that will never be produced (e.g. "make it runnable in an
        // emulator"). The explicit override above is the escape hatch for a real
        // UI issue the heuristic misses.
        const companyDefault = companyRow?.requireDesignFirst ?? false;
        designRequired =
          companyDefault &&
          isLikelyUiWork({
            title: issueRow?.title ?? "",
            description: issueRow?.description ?? null,
          });
      }
      const directGate = deriveIssueDesignGate(workProducts, { designRequired, designExempt });
      if (directGate.approved || designExempt || !designRequired || issueRow?.originKind === "design_request") {
        return directGate;
      }

      const inheritedWorkProducts = await readApprovedInheritedDesigns({
        dbOrTx,
        companyId,
        parentId: issueRow?.parentId ?? null,
        targetScreenKeys: extractExplicitScreenKeys({
          title: issueRow?.title ?? "",
          description: issueRow?.description ?? null,
        }),
      });
      const inheritedGate = deriveIssueDesignGate(inheritedWorkProducts, { designRequired, designExempt });
      // If a duplicate design-request child already exists for the same screen,
      // do not let that unapproved duplicate mask the older board-approved
      // source of truth. The approved same-screen ancestor remains authoritative
      // for implementation issues and prevents recursive design requests.
      return inheritedDesignsCoverCurrentScreens(directGate, inheritedGate)
        ? inheritedGate
        : directGate;
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

    // Multi-screen read: the issue's design artifacts grouped into one entry per
    // canonical screen, each with its current version + version history. This is
    // the screens-first replacement for getAuthoritativeDesignForIssue — an issue
    // can now carry many screens. Idempotent; never throws on read.
    getCurrentScreensForIssue: async (
      issueId: string,
      companyId: string,
      dbOrTx: Db = db,
    ): Promise<DesignScreenGroup[]> => {
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
      return groupDesignsByScreen(rows.map(toIssueWorkProduct));
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
      // WC-202: promoting a new source-of-truth sweeps the issue's superseded
      // 시안 (keeper = this just-promoted row), so versions don't pile up.
      await service.autoDeleteSupersededDesigns(id);
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
      // R3: if that was the LAST mockup of its screen in scope, remove the paired
      // "화면 기획" (screen_plan) too — no orphaned plan. A mere revision (other
      // mockups for the screen remain) keeps the plan. Scope = company + project
      // (project_id NULL = company default app), matching how plans are keyed.
      await service.cleanupOrphanedScreenPlan(existing);
    },

    // R3: remove the paired screen_plan for a screen IF no design-type mockup of
    // that screen remains in scope. Idempotent; safe to call after any design
    // delete. The screen is identified by its canonical screen_key.
    cleanupOrphanedScreenPlan: async (deleted: {
      companyId: string;
      projectId: string | null;
      screenKey: string | null;
      title: string;
    }): Promise<void> => {
      const screenKey = effectiveScreenKey(deleted);
      const scopeProject = deleted.projectId
        ? eq(issueWorkProducts.projectId, deleted.projectId)
        : isNull(issueWorkProducts.projectId);
      const remaining = await db
        .select({ screenKey: issueWorkProducts.screenKey, title: issueWorkProducts.title })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, deleted.companyId),
            scopeProject,
            inArray(issueWorkProducts.type, [...DESIGN_WORK_PRODUCT_TYPES]),
          ),
        );
      const stillHasMockup = remaining.some((r) => effectiveScreenKey(r) === screenKey);
      if (stillHasMockup) return;
      await db
        .delete(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, deleted.companyId),
            scopeProject,
            eq(issueWorkProducts.type, "screen_plan"),
            eq(issueWorkProducts.screenKey, screenKey),
          ),
        );
    },

    // SCREEN-scoped supersession. When a 시안 becomes its screen's current source
    // of truth (approved, or promoted to primary), every OTHER design-type work
    // product ON THE SAME ISSUE that represents the SAME SCREEN (same
    // effectiveScreenKey) is an older version → HARD-DELETE it, so the catalog
    // keeps exactly ONE current 시안 per screen (R2 — no duplicate versions of a
    // page piling up). Crucially a DIFFERENT screen on the same issue is LEFT
    // ALONE — one issue can legitimately carry many screens (R5). A different
    // issue's designs are never touched either (eq issueId). Returns deleted ids.
    autoDeleteSupersededDesigns: async (keeperId: string): Promise<string[]> => {
      const keeper = await service.getById(keeperId);
      if (!keeper || !isDesignWorkProductType(keeper.type)) return [];
      const keeperKey = effectiveScreenKey(keeper);
      const rows = await db
        .select({
          id: issueWorkProducts.id,
          screenKey: issueWorkProducts.screenKey,
          title: issueWorkProducts.title,
        })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, keeper.companyId),
            eq(issueWorkProducts.issueId, keeper.issueId),
            inArray(issueWorkProducts.type, [...DESIGN_WORK_PRODUCT_TYPES]),
          ),
        );
      const deleted: string[] = [];
      for (const row of rows) {
        if (row.id === keeperId) continue;
        // A DIFFERENT screen coexists on the same issue — never sweep it.
        if (effectiveScreenKey(row) !== keeperKey) continue;
        // Same screen, older/superseded version → hard-delete.
        await service.remove(row.id);
        deleted.push(row.id);
      }
      return deleted;
    },

    // R3: upsert the screen's paired "화면 기획" (screen plan). Stored as a
    // non-design 'screen_plan' work product (so it is NEVER a flow node, NEVER
    // holds the design gate, and is immune to autoDeleteSupersededDesigns — the
    // plan survives mockup revisions for free), paired 1:1 to its pure-screen 시안
    // by the SAME canonical screen_key within a scope (company + project). Re-
    // attaching a revised mockup updates the SAME plan row (no orphan/fork) since
    // issue_work_products has no natural unique key here. Returns the plan row id.
    upsertScreenPlan: async (input: {
      issueId: string;
      companyId: string;
      projectId: string | null;
      screenKey: string;
      screenName: string | null;
      planMarkdown: string;
    }): Promise<string | null> => {
      const screenKey = canonicalScreenKey(input.screenKey);
      if (!screenKey) return null;
      const scopeProject = input.projectId
        ? eq(issueWorkProducts.projectId, input.projectId)
        : isNull(issueWorkProducts.projectId);
      const existing = await db
        .select({ id: issueWorkProducts.id })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, input.companyId),
            scopeProject,
            eq(issueWorkProducts.type, "screen_plan"),
            eq(issueWorkProducts.screenKey, screenKey),
          ),
        )
        .limit(1)
        .then((r) => r[0] ?? null);
      if (existing) {
        await db
          .update(issueWorkProducts)
          .set({
            planMarkdown: input.planMarkdown,
            screenName: input.screenName,
            title: input.screenName ?? screenKey,
            updatedAt: new Date(),
          })
          .where(eq(issueWorkProducts.id, existing.id));
        return existing.id;
      }
      const [row] = await db
        .insert(issueWorkProducts)
        .values({
          companyId: input.companyId,
          issueId: input.issueId,
          projectId: input.projectId ?? null,
          type: "screen_plan",
          provider: "workcell",
          screenKey,
          screenName: input.screenName,
          title: input.screenName ?? screenKey,
          status: "active",
          reviewState: "none",
          isPrimary: false,
          planMarkdown: input.planMarkdown,
        })
        .returning({ id: issueWorkProducts.id });
      return row?.id ?? null;
    },

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) => {
      const row = await db.transaction(async (tx) => {
        if (data.isPrimary) {
          await demotePrimarySiblings(tx, {
            companyId,
            issueId,
            type: data.type,
            screenKey: data.screenKey ?? null,
            title: data.title,
            exceptId: null,
          });
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
          await demotePrimarySiblings(tx, {
            companyId: existing.companyId,
            issueId: existing.issueId,
            type: (patch.type ?? existing.type) as string,
            screenKey: (patch.screenKey ?? existing.screenKey) ?? null,
            title: patch.title ?? existing.title,
            exceptId: id,
          });
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
