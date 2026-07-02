import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Maximize2, PencilRuler, Target } from "lucide-react";
import {
  groupDesignsByScreen,
  isDesignWorkProductType,
  type IssueWorkProduct,
} from "@workcell/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { queryKeys } from "../lib/queryKeys";
import { issuesApi } from "../api/issues";
import { designArtifactsApi, type DesignArtifact } from "../api/design-artifacts";
import { useToastActions } from "../context/ToastContext";
import { issueUrl } from "../lib/utils";
import { toDisplayPreviewUrl } from "../lib/previewUrl";
import { StatusBadge } from "./StatusBadge";

// WC-182 / D22: the design-review gate UI — the visible payoff of D22. The
// isPrimary design-type work product on an issue IS that issue's SOURCE OF TRUTH
// design; `reviewState` is its review gate. This panel surfaces that authoritative
// design, its review state, a sandboxed preview, and the state-appropriate board
// actions (submit / approve / request changes), mirroring PairSetupPanel's
// react-query + toast conventions.

// The server's createDesignArtifactSchema validates `url` with zod .url(),
// which accepts only absolute URLs. Guard catalog-forwarded urls so a relative
// path / bare slug (possible on externally-ingested artifacts) doesn't fail the
// whole attach.
function isAbsoluteUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function DesignPreview({ url, title }: { url: string | null; title: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (!url) {
    return (
      <p className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">
        {t("issueDesignReview.noPreview", {
          defaultValue: "No preview available for this design.",
        })}
      </p>
    );
  }
  const previewTitle = t("issueDesignReview.previewTitle", {
    defaultValue: "Design preview: {{title}}",
    title,
  });
  // Load the 시안 against the CURRENT origin (fixes baked-in http://127.0.0.1:3100
  // asset urls that fail when the board opens Workcell from another device/host).
  const src = toDisplayPreviewUrl(url) ?? url;
  return (
    <div className="relative">
      {/* Sandboxed: render the design preview without granting it any privileges
          (no scripts, same-origin, forms, popups, or top-level navigation). The
          issue-detail column is narrow, so make it tall + offer an expand /
          new-tab to actually read the 시안. */}
      <iframe
        sandbox=""
        src={src}
        title={previewTitle}
        className="h-[60vh] min-h-[420px] w-full rounded-md border border-border bg-background"
        data-testid="design-review-preview"
      />
      <div className="absolute right-2 top-2 flex gap-1">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title={t("issueDesignReview.expandPreview", { defaultValue: "Expand" })}
          aria-label={t("issueDesignReview.expandPreview", { defaultValue: "Expand" })}
          className="rounded-md border border-border bg-background/90 p-1.5 text-muted-foreground shadow-sm hover:text-foreground"
          data-testid="design-review-preview-expand"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          title={t("issueDesignReview.openPreviewNewTab", { defaultValue: "Open in new tab" })}
          aria-label={t("issueDesignReview.openPreviewNewTab", { defaultValue: "Open in new tab" })}
          className="rounded-md border border-border bg-background/90 p-1.5 text-muted-foreground shadow-sm hover:text-foreground"
          data-testid="design-review-preview-newtab"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-[95vw] sm:max-w-5xl h-[85vh] p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>{previewTitle}</DialogTitle>
          </DialogHeader>
          <iframe
            sandbox=""
            src={src}
            title={previewTitle}
            className="h-full w-full rounded-md"
            data-testid="design-review-preview-modal"
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function IssueDesignReviewPanel({ issueId }: { issueId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  // Inline reason for "request changes" while in needs_board_review.
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  // Inline attach-design form (shown from the empty state).
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachTitle, setAttachTitle] = useState("");
  const [attachUrl, setAttachUrl] = useState("");
  // Pick an existing screen 시안 from the project design system catalog — the
  // per-screen design becomes this issue's source of truth instead of being
  // re-authored from scratch.
  const [pickOpen, setPickOpen] = useState(false);

  const workProductsQueryKey = queryKeys.issues.workProducts(issueId);
  const { data: workProducts, isLoading } = useQuery({
    queryKey: workProductsQueryKey,
    queryFn: () => issuesApi.listWorkProducts(issueId),
    enabled: !!issueId,
  });

  const designs = (workProducts ?? []).filter((wp) => isDesignWorkProductType(wp.type));
  // Design-system redesign (R5): an issue can hold MANY screens. Group the issue's
  // design artifacts into one entry per screen so the board can review each. The
  // detailed gate below operates on the ACTIVE screen's current 시안.
  const screens = groupDesignsByScreen(designs);
  const [activeScreenKey, setActiveScreenKey] = useState<string | null>(null);
  const activeScreen =
    screens.find((s) => s.screenKey === activeScreenKey) ??
    screens.find((s) => s.current.isPrimary === true) ??
    screens[0] ??
    null;
  const authoritative = activeScreen?.current ?? null;
  // Every screen of the issue is approved → development releases (R3: 전 화면 승인).
  const allScreensApproved = screens.length > 0 && screens.every((s) => s.approved);
  // WC-200: once the primary design is approved it becomes the implementation
  // target — the gate copy flips from "waiting" to "this is what we build".
  const approvedTarget = authoritative?.reviewState === "approved";

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: workProductsQueryKey });
    // A design-review decision (submit / approve / request-changes) changes the
    // company- and project-scoped design-artifact lists that the board's inbox
    // (the "할 일" tab + sidebar badge) and the Design System page read — not
    // just this issue's work products. Invalidate the whole design-artifacts
    // family (prefix match covers ["design-artifacts", companyId, "inbox-page"
    // | "inbox-badge" | "list", …]) so an approved 시안 disappears from the
    // inbox/badge immediately instead of lingering until a refetch.
    queryClient.invalidateQueries({ queryKey: ["design-artifacts"] });
    queryClient.invalidateQueries({ queryKey: ["project-design-artifacts"] });
  }

  // WC-196: per-issue design-first opt-out. The server returns the issue's
  // designRequirement override (WC-197 declares it on the shared Issue type).
  // { required:false } exempts this issue from the design-first gate (e.g.
  // obvious backend-only work).
  const issueQueryKey = ["issue-design-requirement", issueId] as const;
  const { data: issueRow } = useQuery({
    queryKey: issueQueryKey,
    queryFn: () => issuesApi.get(issueId),
    enabled: !!issueId,
  });
  const designRequirement = issueRow?.designRequirement ?? null;
  const designExempt = designRequirement?.required === false;
  // A design_request child IS the 시안-creation task — it's auto design-exempt,
  // so the plain panel renders a confusing "design not required" toggle. Show a
  // clear "make the 시안 for the parent, attach it THERE" guidance instead; the
  // 시안 itself belongs on the parent issue, never on this child.
  const isDesignRequest = issueRow?.originKind === "design_request";
  const designRequestParentId = issueRow?.originId ?? issueRow?.parentId ?? null;
  const { data: designRequestParent } = useQuery({
    queryKey: ["design-request-parent", designRequestParentId],
    queryFn: () => issuesApi.get(designRequestParentId!),
    enabled: isDesignRequest && !!designRequestParentId,
  });
  // WC-200: the issue's project anchors the design system link — the project's
  // design system is the source of truth for what 시안 in this project look like.
  const projectId = issueRow?.projectId ?? null;
  const setDesignRequirement = useMutation({
    mutationFn: (required: boolean) =>
      issuesApi.setDesignRequirement(issueId, {
        required,
        reason: required ? null : "비-화면 작업 (디자인 불필요)",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: issueQueryKey });
      // WC-199: also refresh the canonical issue cache IssueDetail reads from, so a
      // toggled design-requirement isn't left stale on the shared Issue object.
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      invalidate();
    },
    onError,
  });

  function onError(err: unknown) {
    pushToast({
      title: t("issueDesignReview.toast.failed.title", {
        defaultValue: "Design review action failed",
      }),
      body:
        err instanceof Error
          ? err.message
          : t("issueDesignReview.toast.failed.body", {
              defaultValue: "Workcell could not update the design review.",
            }),
      tone: "error",
    });
  }

  const submit = useMutation({
    mutationFn: (workProductId: string) => issuesApi.submitDesignReview(workProductId),
    onSuccess: invalidate,
    onError,
  });
  const approve = useMutation({
    mutationFn: (workProductId: string) => issuesApi.approveDesignReview(workProductId),
    onSuccess: invalidate,
    onError,
  });
  const requestChanges = useMutation({
    mutationFn: (vars: { id: string; reason?: string }) =>
      issuesApi.requestDesignChanges(vars.id, vars.reason),
    onSuccess: () => {
      setReasonOpen(false);
      setReason("");
      invalidate();
    },
    onError,
  });
  // First design attached → make it the authoritative source of truth so the
  // panel immediately surfaces the "request review" gate (reviewState "none").
  const attach = useMutation({
    mutationFn: (vars: { title: string; url?: string }) =>
      issuesApi.createDesignArtifact(issueId, {
        title: vars.title,
        url: vars.url,
        isPrimary: true,
      }),
    onSuccess: () => {
      setAttachOpen(false);
      setAttachTitle("");
      setAttachUrl("");
      invalidate();
    },
    onError,
  });

  // Project design system catalog — the per-screen 시안 inventory this issue can
  // reuse. Loaded lazily when the picker opens.
  const { data: projectDesigns, isLoading: projectDesignsLoading } = useQuery({
    queryKey: ["project-design-artifacts", projectId],
    queryFn: () => designArtifactsApi.listForProject(projectId!),
    enabled: !!projectId && pickOpen,
  });
  // Designs from OTHER issues only — this issue's own artifacts already render
  // above. Newest-first mirrors the Design System catalog ordering.
  const catalogDesigns = (projectDesigns?.items ?? []).filter(
    (artifact) => artifact.issueId !== issueId,
  );
  const attachFromCatalog = useMutation({
    mutationFn: (artifact: DesignArtifact) =>
      issuesApi.createDesignArtifact(issueId, {
        title: artifact.title,
        // The server validates url with zod .url() (absolute URLs only). A
        // catalog artifact's stored previewUrl can be a relative path or bare
        // slug for externally-ingested designs, which would fail the whole
        // attach with a generic error toast. Forward it only when it's an
        // absolute URL; otherwise attach without a preview link.
        url: isAbsoluteUrl(artifact.previewUrl) ? artifact.previewUrl! : undefined,
        type: artifact.type,
        summary: artifact.body ?? undefined,
        isPrimary: true,
        // Provenance: which catalog 시안 this issue's source of truth came from.
        metadata: { sourceWorkProductId: artifact.id },
      }),
    onSuccess: () => {
      setPickOpen(false);
      invalidate();
    },
    onError,
  });

  const anyPending =
    submit.isPending ||
    approve.isPending ||
    requestChanges.isPending ||
    attach.isPending ||
    attachFromCatalog.isPending;

  function submitAttach() {
    const title = attachTitle.trim();
    if (!title) return;
    const url = attachUrl.trim();
    attach.mutate({ title, url: url || undefined });
  }

  function submitReason(workProductId: string) {
    const trimmed = reason.trim();
    requestChanges.mutate({ id: workProductId, reason: trimmed || undefined });
  }

  // A design_request child: this issue IS the 시안-creation work. Don't show the
  // "design not required" toggle (it reads as "no design needed" — the opposite
  // of the truth). Point the designer at the PARENT, where the 시안 must land.
  if (isDesignRequest) {
    const parentLabel =
      designRequestParent?.identifier ?? designRequestParent?.title ?? null;
    // Normally a design_request child holds NO 시안 of its own — the mockup belongs
    // on the PARENT and the board approves it there. But some children end up
    // carrying a primary 시안 that reached needs_board_review here; the inbox
    // surfaces it as a board "할 일", yet this panel used to show only "attach to
    // parent" guidance with NO approve control, stranding the board on a page with
    // nothing to act on (the To-do-with-no-button bug). When such a pending 시안 is
    // present, let the board decide on it right here — the server folds a
    // design_request child's approved design into the parent's design gate, so
    // approving here clears the parent too.
    // Scan ALL screens, not just the active/primary one: a child carrying 시안 for
    // several screens must keep offering the approve control for the NEXT pending
    // screen after the first is approved — otherwise the inbox To-do (which counts
    // any pending primary artifact on the issue) would again point at a page with
    // no button.
    const pendingChildDesign =
      screens.map((s) => s.current).find((c) => c?.reviewState === "needs_board_review") ?? null;
    return (
      <section
        className="space-y-3 rounded-lg border border-border p-3"
        data-testid="design-review-panel"
      >
        <header className="flex items-start gap-2">
          <PencilRuler className="mt-0.5 h-4 w-4 shrink-0 text-violet-500 dark:text-violet-300" />
          <h3 className="text-sm font-semibold">
            {pendingChildDesign
              ? t("issueDesignReview.designRequest.reviewHeading", {
                  defaultValue: "Design task — mockup awaiting board review",
                })
              : t("issueDesignReview.designRequest.heading", {
                  defaultValue: "Design task — make the mockup",
                })}
          </h3>
        </header>
        {pendingChildDesign ? (
          <div className="space-y-2.5" data-testid="design-request-pending-review">
            <p className="text-xs text-muted-foreground">
              {t("issueDesignReview.designRequest.reviewBody", {
                defaultValue:
                  "This design task is carrying its own mockup and it is awaiting board review. Approve it or request changes here — approving it clears the parent's design gate.",
              })}
            </p>
            <DesignPreview url={pendingChildDesign.url} title={pendingChildDesign.title} />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-8"
                disabled={anyPending}
                onClick={() => approve.mutate(pendingChildDesign.id)}
                data-testid="design-review-approve"
              >
                {approve.isPending ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t("issueDesignReview.approving", { defaultValue: "Approving…" })}
                  </>
                ) : (
                  t("issueDesignReview.action.approve", { defaultValue: "Approve" })
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={anyPending}
                onClick={() => setReasonOpen((v) => !v)}
                data-testid="design-review-request-changes-toggle"
              >
                {t("issueDesignReview.action.requestChanges", { defaultValue: "Request changes" })}
              </Button>
            </div>
            {reasonOpen ? (
              <div className="space-y-2">
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder={t("issueDesignReview.reasonPlaceholder", {
                    defaultValue: "What should change? (optional)",
                  })}
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                  data-testid="design-review-reason"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={anyPending}
                  onClick={() => submitReason(pendingChildDesign.id)}
                  data-testid="design-review-request-changes"
                >
                  {requestChanges.isPending ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      {t("issueDesignReview.requesting", { defaultValue: "Sending…" })}
                    </>
                  ) : (
                    t("issueDesignReview.action.sendChanges", { defaultValue: "Send change request" })
                  )}
                </Button>
              </div>
            ) : null}
            {designRequestParent ? (
              <Link
                to={issueUrl(designRequestParent)}
                className="inline-flex items-center text-xs text-muted-foreground transition-colors hover:text-foreground"
                data-testid="design-request-parent-link"
              >
                {parentLabel
                  ? t("issueDesignReview.designRequest.openParent", {
                      defaultValue: "Open parent {{parent}} →",
                      parent: parentLabel,
                    })
                  : t("issueDesignReview.designRequest.openParentGeneric", {
                      defaultValue: "Open the parent issue →",
                    })}
              </Link>
            ) : null}
          </div>
        ) : (
          <div
            className="space-y-1.5 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2.5 text-xs"
            data-testid="design-request-guidance"
          >
            <p className="text-foreground">
              {t("issueDesignReview.designRequest.body", {
                defaultValue:
                  "This issue is the mockup-creation task, so it needs no design of its own. Create the design for the parent screen and attach it to the PARENT issue, then request board review — once approved, the parent's implementation resumes.",
              })}
            </p>
            {designRequestParent ? (
              <Link
                to={issueUrl(designRequestParent)}
                className="inline-flex items-center font-medium text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
                data-testid="design-request-parent-link"
              >
                {parentLabel
                  ? t("issueDesignReview.designRequest.attachTo", {
                      defaultValue: "Attach the mockup to {{parent}} →",
                      parent: parentLabel,
                    })
                  : t("issueDesignReview.designRequest.attachToParent", {
                      defaultValue: "Attach the mockup to the parent issue →",
                    })}
              </Link>
            ) : null}
          </div>
        )}
        {projectId ? (
          <Link
            to={`/projects/${projectId}/design`}
            className="inline-flex items-center text-xs text-muted-foreground transition-colors hover:text-foreground"
            data-testid="design-review-project-design-link"
          >
            {t("issueDesignReview.projectDesignSystem", {
              defaultValue: "Project design system →",
            })}
          </Link>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-border p-3"
      data-testid="design-review-panel"
    >
      <header className="flex items-start gap-2">
        <PencilRuler className="mt-0.5 h-4 w-4 shrink-0 text-violet-500 dark:text-violet-300" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">
            {t("issueDesignReview.title", { defaultValue: "Design (source of truth)" })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("issueDesignReview.subtitle", {
              defaultValue:
                "This design is the source of truth for this work — development and QA proceed against it.",
            })}
          </p>
        </div>
      </header>

      {/* WC-196: design-first opt-out — exempt obvious non-screen work.
          WC-200: the required state is goal-framed — an approved 시안 is the
          implementation target, not a punitive completion blocker. */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
        data-testid="design-requirement-toggle"
      >
        <span className="text-xs text-muted-foreground">
          {designExempt
            ? t("issueDesignReview.requirement.exempt", {
                defaultValue: "Design not required — this issue is exempt from the design gate",
              })
            : approvedTarget
              ? t("issueDesignReview.requirement.met", {
                  defaultValue: "Design-first — the approved design below is the implementation target",
                })
              : t("issueDesignReview.requirement.required", {
                  defaultValue:
                    "Awaiting design — this issue is implemented toward an approved design",
                })}
          {designRequirement?.setByKind === "auto" ? (
            <span className="ml-1 opacity-70">
              {t("issueDesignReview.requirement.setByAi", { defaultValue: "· AI-set" })}
            </span>
          ) : null}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 text-xs"
          disabled={setDesignRequirement.isPending}
          onClick={() => setDesignRequirement.mutate(designExempt)}
          data-testid="design-requirement-toggle-btn"
        >
          {designExempt
            ? t("issueDesignReview.requirement.makeRequired", { defaultValue: "Require design" })
            : t("issueDesignReview.requirement.makeExempt", { defaultValue: "Mark exempt" })}
        </Button>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">
          {t("issueDesignReview.loading", { defaultValue: "Loading designs…" })}
        </p>
      ) : authoritative ? (
        <div className="space-y-3" data-testid="design-review-authoritative">
          {/* Design-system redesign (R5): when the issue has multiple screens,
              show a selector so the board reviews each one. The detailed gate
              below acts on the active screen. Development releases only when
              EVERY screen is approved (R3). */}
          {screens.length > 1 ? (
            <div
              className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/20 p-2"
              data-testid="design-review-screen-selector"
            >
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {t("issueDesignReview.screens.count", {
                    defaultValue: "{{count}} screens in this issue",
                    count: screens.length,
                  })}
                </span>
                <span className={allScreensApproved ? "text-emerald-600 dark:text-emerald-400" : ""}>
                  {t("issueDesignReview.screens.approvedCount", {
                    defaultValue: "{{approved}}/{{total}} approved",
                    approved: screens.filter((s) => s.approved).length,
                    total: screens.length,
                  })}
                  {allScreensApproved
                    ? t("issueDesignReview.screens.canStartDev", {
                        defaultValue: " · ready to start development",
                      })
                    : ""}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {screens.map((s) => {
                  const active = s.screenKey === (activeScreen?.screenKey ?? null);
                  return (
                    <button
                      key={s.screenKey}
                      type="button"
                      onClick={() => setActiveScreenKey(s.screenKey)}
                      data-testid="design-review-screen-chip"
                      className={
                        "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition " +
                        (active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground")
                      }
                    >
                      <span
                        className={
                          "h-1.5 w-1.5 rounded-full " +
                          (s.approved
                            ? "bg-emerald-500"
                            : s.current.reviewState === "needs_board_review"
                              ? "bg-amber-500"
                              : s.current.reviewState === "changes_requested"
                                ? "bg-red-500"
                                : "bg-muted-foreground/50")
                        }
                      />
                      {s.screenName}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium" title={authoritative.title}>
              {authoritative.title}
            </span>
            <StatusBadge status={authoritative.reviewState} />
          </div>

          {/* WC-200: approved primary design = the implementation target. The
              emphasis card frames the gate as the goal the work follows — build
              this 시안 exactly; QA verifies against it. */}
          {authoritative.reviewState === "approved" ? (
            <div
              className="space-y-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5"
              data-testid="design-review-approved"
            >
              <div className="flex items-center gap-1.5">
                <Target className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                  {t("issueDesignReview.target.title", { defaultValue: "Implementation target" })}
                </span>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="min-w-0 truncate text-sm font-medium" title={authoritative.title}>
                  {authoritative.title}
                </span>
                {authoritative.url ? (
                  <a
                    href={authoritative.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-xs text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300"
                    data-testid="design-review-target-link"
                  >
                    {t("issueDesignReview.target.view", { defaultValue: "View design" })}
                  </a>
                ) : null}
              </div>
              <p className="text-xs text-emerald-700 dark:text-emerald-300">
                {t("issueDesignReview.target.note", {
                  defaultValue:
                    "Implement this design exactly — QA verifies the result against it.",
                })}
              </p>
            </div>
          ) : null}

          {/* WC-182f / D22 + WC-200: while the source-of-truth design awaits
              approval, the note frames what approval unlocks — this design
              becomes the implementation target — mirroring the agent-facing
              directive in the heartbeat context. */}
          {authoritative.reviewState === "needs_board_review" ||
          authoritative.reviewState === "changes_requested" ? (
            <p
              className="text-xs text-amber-700 dark:text-amber-300"
              data-testid="design-review-hold"
            >
              {t("issueDesignReview.hold", {
                defaultValue:
                  "Design under review — once approved, this design becomes the implementation target.",
              })}
            </p>
          ) : null}

          <DesignPreview url={authoritative.url} title={authoritative.title} />

          {/* State-appropriate actions. */}
          {authoritative.reviewState === "none" ? (
            <Button
              size="sm"
              className="h-8"
              disabled={anyPending}
              onClick={() => submit.mutate(authoritative.id)}
              data-testid="design-review-submit"
            >
              {submit.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t("issueDesignReview.submitting", { defaultValue: "Requesting…" })}
                </>
              ) : (
                t("issueDesignReview.action.submit", { defaultValue: "Request review" })
              )}
            </Button>
          ) : null}

          {authoritative.reviewState === "needs_board_review" ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  className="h-8"
                  disabled={anyPending}
                  onClick={() => approve.mutate(authoritative.id)}
                  data-testid="design-review-approve"
                >
                  {approve.isPending ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      {t("issueDesignReview.approving", { defaultValue: "Approving…" })}
                    </>
                  ) : (
                    t("issueDesignReview.action.approve", { defaultValue: "Approve" })
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={anyPending}
                  onClick={() => setReasonOpen((v) => !v)}
                  data-testid="design-review-request-changes-toggle"
                >
                  {t("issueDesignReview.action.requestChanges", { defaultValue: "Request changes" })}
                </Button>
              </div>
              {reasonOpen ? (
                <div className="space-y-2">
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    placeholder={t("issueDesignReview.reasonPlaceholder", {
                      defaultValue: "What should change? (optional)",
                    })}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                    data-testid="design-review-reason"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    disabled={anyPending}
                    onClick={() => submitReason(authoritative.id)}
                    data-testid="design-review-request-changes"
                  >
                    {requestChanges.isPending ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        {t("issueDesignReview.requesting", { defaultValue: "Sending…" })}
                      </>
                    ) : (
                      t("issueDesignReview.action.sendChanges", { defaultValue: "Send change request" })
                    )}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {authoritative.reviewState === "approved" ? (
            <p
              className="mb-2 text-xs text-muted-foreground"
              data-testid="design-review-approved-impl-hint"
            >
              {t("issueDesignReview.approvedImplementing", {
                defaultValue:
                  "The design is approved. This signals \"implement against this mockup,\" not that the issue is done — the assignee implements to this mockup, attaches proof, and only then marks the issue complete. (Issue-completion approval is separate.)",
              })}
            </p>
          ) : null}

          {authoritative.reviewState === "approved" ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-muted-foreground"
              disabled={anyPending}
              onClick={() => requestChanges.mutate({ id: authoritative.id })}
              data-testid="design-review-reopen"
            >
              {requestChanges.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t("issueDesignReview.requesting", { defaultValue: "Sending…" })}
                </>
              ) : (
                t("issueDesignReview.action.reopen", { defaultValue: "Request changes" })
              )}
            </Button>
          ) : null}

          {authoritative.reviewState === "changes_requested" ? (
            <Button
              size="sm"
              className="h-8"
              disabled={anyPending}
              onClick={() => submit.mutate(authoritative.id)}
              data-testid="design-review-resubmit"
            >
              {submit.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t("issueDesignReview.submitting", { defaultValue: "Requesting…" })}
                </>
              ) : (
                t("issueDesignReview.action.resubmit", { defaultValue: "Resubmit for review" })
              )}
            </Button>
          ) : null}
        </div>
      ) : designs.length > 0 ? (
        <div className="space-y-2" data-testid="design-review-candidates">
          <p className="text-xs text-muted-foreground">
            {t("issueDesignReview.candidatesNote", {
              defaultValue:
                "No design is the source of truth yet. Pick one to make it authoritative and request review.",
            })}
          </p>
          <ul className="-mx-1 flex flex-col">
            {designs.map((wp) => (
              <li
                key={wp.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md px-1 py-1.5 hover:bg-accent/40"
              >
                <span className="min-w-0 flex-1 truncate text-sm" title={wp.title}>
                  {wp.title}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={anyPending}
                  onClick={() => submit.mutate(wp.id)}
                  data-testid={`design-review-designate-${wp.id}`}
                >
                  {submit.isPending && submit.variables === wp.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    t("issueDesignReview.action.designate", {
                      defaultValue: "Make source of truth + request review",
                    })
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-2.5">
          <p className="text-xs text-muted-foreground" data-testid="design-review-empty">
            {t("issueDesignReview.empty", {
              defaultValue:
                "No design yet — once a designer attaches one, you can review it here.",
            })}
          </p>
          {/* WC-200: 시안 follow the project design system — the project-level
              source of truth for design planning. */}
          {!designExempt ? (
            <p
              className="text-xs text-muted-foreground/80"
              data-testid="design-review-design-system-note"
            >
              {t("issueDesignReview.designSystemNote", {
                defaultValue: "Designs follow the project's design system.",
              })}
            </p>
          ) : null}

          {attachOpen ? (
            <div className="space-y-2" data-testid="design-review-attach-form">
              <input
                value={attachTitle}
                onChange={(e) => setAttachTitle(e.target.value)}
                placeholder={t("issueDesignReview.attach.titlePlaceholder", {
                  defaultValue: "Design title",
                })}
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                data-testid="design-review-attach-title"
              />
              <input
                value={attachUrl}
                onChange={(e) => setAttachUrl(e.target.value)}
                placeholder={t("issueDesignReview.attach.urlPlaceholder", {
                  defaultValue: "https://… or leave empty",
                })}
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                data-testid="design-review-attach-url"
              />
              <Button
                size="sm"
                className="h-8"
                disabled={anyPending || attachTitle.trim().length === 0}
                onClick={submitAttach}
                data-testid="design-review-attach-submit"
              >
                {attach.isPending ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t("issueDesignReview.attach.submitting", { defaultValue: "Attaching…" })}
                  </>
                ) : (
                  t("issueDesignReview.attach.submit", { defaultValue: "Attach" })
                )}
              </Button>
            </div>
          ) : pickOpen ? (
            <div className="space-y-2" data-testid="design-review-pick-list">
              {projectDesignsLoading ? (
                <p className="text-xs text-muted-foreground">
                  {t("issueDesignReview.pick.loading", { defaultValue: "Loading design system…" })}
                </p>
              ) : catalogDesigns.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("issueDesignReview.pick.empty", {
                    defaultValue: "No screen designs in the project design system yet.",
                  })}
                </p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto">
                  {catalogDesigns.map((artifact) => (
                    <li
                      key={artifact.id}
                      className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm" title={artifact.title}>
                        {artifact.title}
                      </span>
                      <StatusBadge status={artifact.reviewState} />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 text-xs"
                        disabled={anyPending}
                        onClick={() => attachFromCatalog.mutate(artifact)}
                        data-testid={`design-review-pick-${artifact.id}`}
                      >
                        {attachFromCatalog.isPending &&
                        attachFromCatalog.variables?.id === artifact.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          t("issueDesignReview.pick.use", { defaultValue: "Use as source of truth" })
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                disabled={anyPending}
                onClick={() => setPickOpen(false)}
                data-testid="design-review-pick-close"
              >
                {t("issueDesignReview.pick.close", { defaultValue: "Cancel" })}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={anyPending}
                onClick={() => setAttachOpen(true)}
                data-testid="design-review-attach-toggle"
              >
                {t("issueDesignReview.attach.button", { defaultValue: "Attach design" })}
              </Button>
              {projectId ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={anyPending}
                  onClick={() => setPickOpen(true)}
                  data-testid="design-review-pick-toggle"
                >
                  {t("issueDesignReview.pick.button", {
                    defaultValue: "Choose from design system",
                  })}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* WC-200: the project design system is the source of truth for this
          project's design planning — link it whenever the issue has a project. */}
      {projectId ? (
        <Link
          to={`/projects/${projectId}/design`}
          className="inline-flex items-center text-xs text-muted-foreground transition-colors hover:text-foreground"
          data-testid="design-review-project-design-link"
        >
          {t("issueDesignReview.projectDesignSystem", {
            defaultValue: "Project design system →",
          })}
        </Link>
      ) : null}
    </section>
  );
}
