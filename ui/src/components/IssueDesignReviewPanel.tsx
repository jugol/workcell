import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, PencilRuler } from "lucide-react";
import { isDesignWorkProductType, type IssueWorkProduct } from "@workcell/shared";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { queryKeys } from "../lib/queryKeys";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { StatusBadge } from "./StatusBadge";

// WC-182 / D22: the design-review gate UI — the visible payoff of D22. The
// isPrimary design-type work product on an issue IS that issue's SOURCE OF TRUTH
// design; `reviewState` is its review gate. This panel surfaces that authoritative
// design, its review state, a sandboxed preview, and the state-appropriate board
// actions (submit / approve / request changes), mirroring PairSetupPanel's
// react-query + toast conventions.

function DesignPreview({ url, title }: { url: string | null; title: string }) {
  const { t } = useTranslation();
  if (!url) {
    return (
      <p className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">
        {t("issueDesignReview.noPreview", {
          defaultValue: "No preview available for this design.",
        })}
      </p>
    );
  }
  return (
    <iframe
      // Sandboxed: render the design preview without granting it any privileges
      // (no scripts, same-origin, forms, popups, or top-level navigation).
      sandbox=""
      src={url}
      title={t("issueDesignReview.previewTitle", {
        defaultValue: "Design preview: {{title}}",
        title,
      })}
      className="h-64 w-full rounded-md border border-border bg-background"
      data-testid="design-review-preview"
    />
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

  const workProductsQueryKey = queryKeys.issues.workProducts(issueId);
  const { data: workProducts, isLoading } = useQuery({
    queryKey: workProductsQueryKey,
    queryFn: () => issuesApi.listWorkProducts(issueId),
    enabled: !!issueId,
  });

  const designs = (workProducts ?? []).filter((wp) => isDesignWorkProductType(wp.type));
  const authoritative = designs.find((wp) => wp.isPrimary === true) ?? null;

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: workProductsQueryKey });
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

  const anyPending =
    submit.isPending || approve.isPending || requestChanges.isPending || attach.isPending;

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

      {/* WC-196: design-first opt-out — exempt obvious non-screen work. */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
        data-testid="design-requirement-toggle"
      >
        <span className="text-xs text-muted-foreground">
          {designExempt
            ? t("issueDesignReview.requirement.exempt", {
                defaultValue: "디자인 불필요 — 이 이슈는 디자인 게이트 예외",
              })
            : t("issueDesignReview.requirement.required", {
                defaultValue: "디자인 필요 — 승인된 시안 없이는 완료 불가",
              })}
          {designRequirement?.setByKind === "auto" ? (
            <span className="ml-1 opacity-70">· AI 설정</span>
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
            ? t("issueDesignReview.requirement.makeRequired", { defaultValue: "디자인 필요로" })
            : t("issueDesignReview.requirement.makeExempt", { defaultValue: "예외 처리" })}
        </Button>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">
          {t("issueDesignReview.loading", { defaultValue: "Loading designs…" })}
        </p>
      ) : authoritative ? (
        <div className="space-y-3" data-testid="design-review-authoritative">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium" title={authoritative.title}>
              {authoritative.title}
            </span>
            <StatusBadge status={authoritative.reviewState} />
          </div>

          {authoritative.reviewState === "approved" ? (
            <div
              className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2"
              data-testid="design-review-approved"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
              <p className="text-xs text-green-700 dark:text-green-300">
                {t("issueDesignReview.approvedNote", {
                  defaultValue:
                    "Approved — this design is the locked source of truth for the issue.",
                })}
              </p>
            </div>
          ) : null}

          {/* WC-182f / D22: while the source-of-truth design is not yet approved
              (needs_board_review or changes_requested), development holds — a
              subtle note mirrors the agent-facing HOLD directive in the
              heartbeat context. */}
          {authoritative.reviewState === "needs_board_review" ||
          authoritative.reviewState === "changes_requested" ? (
            <p
              className="text-xs text-amber-700 dark:text-amber-300"
              data-testid="design-review-hold"
            >
              {t("issueDesignReview.hold", {
                defaultValue: "Development holds until this design is approved.",
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
          ) : (
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
          )}
        </div>
      )}
    </section>
  );
}
