import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";

// WC-188 / CP7: user feedback on a PLAN revises the plan/기획 — the PLAN-side
// mirror of the design request-changes→designer loop (IssueDesignReviewPanel).
// "The plan" for an issue is its description + plan/issue-draft document; this
// affordance lets a board user write feedback that is recorded on the issue and
// routed to the planner-capable agent to revise the plan. Mirrors the design
// panel's react-query + toast + reason-textarea conventions.
export function IssuePlanRevisionPanel({ issueId }: { issueId: string }) {
  const { t } = useTranslation();
  const { pushToast } = useToastActions();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  const requestRevision = useMutation({
    mutationFn: (reason: string) => issuesApi.requestPlanRevision(issueId, reason),
    onSuccess: () => {
      setOpen(false);
      setFeedback("");
      pushToast({
        title: t("issuePlanRevision.toast.success.title", {
          defaultValue: "Plan revision requested",
        }),
        body: t("issuePlanRevision.toast.success.body", {
          defaultValue: "Sent your feedback to the planner to revise the plan.",
        }),
        tone: "success",
      });
    },
    onError: (err: unknown) => {
      pushToast({
        title: t("issuePlanRevision.toast.failed.title", {
          defaultValue: "Could not request a plan revision",
        }),
        body:
          err instanceof Error
            ? err.message
            : t("issuePlanRevision.toast.failed.body", {
                defaultValue: "Workcell could not request a plan revision.",
              }),
        tone: "error",
      });
    },
  });

  function submit() {
    const trimmed = feedback.trim();
    if (!trimmed || requestRevision.isPending) return;
    requestRevision.mutate(trimmed);
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-border p-3"
      data-testid="plan-revision-panel"
    >
      <header className="flex items-start gap-2">
        <PencilLine className="mt-0.5 h-4 w-4 shrink-0 text-sky-500 dark:text-sky-300" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">
            {t("issuePlanRevision.title", { defaultValue: "Plan (기획)" })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("issuePlanRevision.subtitle", {
              defaultValue:
                "Give feedback on this plan and the planner will revise it.",
            })}
          </p>
        </div>
      </header>

      {open ? (
        <div className="space-y-2" data-testid="plan-revision-form">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            placeholder={t("issuePlanRevision.feedbackPlaceholder", {
              defaultValue: "What should the planner change about this plan?",
            })}
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            data-testid="plan-revision-feedback"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-8"
              disabled={requestRevision.isPending || feedback.trim().length === 0}
              onClick={submit}
              data-testid="plan-revision-submit"
            >
              {requestRevision.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t("issuePlanRevision.sending", { defaultValue: "Sending…" })}
                </>
              ) : (
                t("issuePlanRevision.action.send", { defaultValue: "Send to planner" })
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-muted-foreground"
              disabled={requestRevision.isPending}
              onClick={() => {
                setOpen(false);
                setFeedback("");
              }}
              data-testid="plan-revision-cancel"
            >
              {t("issuePlanRevision.action.cancel", { defaultValue: "Cancel" })}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => setOpen(true)}
          data-testid="plan-revision-toggle"
        >
          {t("issuePlanRevision.action.requestRevision", {
            defaultValue: "Request plan revision",
          })}
        </Button>
      )}
    </section>
  );
}
