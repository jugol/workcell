import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace } from "@workcell/shared";
import { Link } from "@/lib/router";
import { Loader2 } from "lucide-react";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { useToastActions } from "../context/ToastContext";
import { useTranslation } from "@/i18n";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, issueUrl } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type ExecutionWorkspaceCloseDialogProps = {
  workspaceId: string;
  workspaceName: string;
  currentStatus: ExecutionWorkspace["status"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed?: (workspace: ExecutionWorkspace) => void;
};

function readinessTone(state: "ready" | "ready_with_warnings" | "blocked") {
  if (state === "blocked") {
    return "border-destructive/30 bg-destructive/5 text-destructive";
  }
  if (state === "ready_with_warnings") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

export function ExecutionWorkspaceCloseDialog({
  workspaceId,
  workspaceName,
  currentStatus,
  open,
  onOpenChange,
  onClosed,
}: ExecutionWorkspaceCloseDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { t } = useTranslation();
  const actionLabel = currentStatus === "cleanup_failed"
    ? t("executionWorkspaceClose.action.retryClose", { defaultValue: "Retry close" })
    : t("executionWorkspaceClose.action.closeWorkspace", { defaultValue: "Close workspace" });

  const readinessQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.closeReadiness(workspaceId),
    queryFn: () => executionWorkspacesApi.getCloseReadiness(workspaceId),
    enabled: open,
  });

  const closeWorkspace = useMutation({
    mutationFn: () => executionWorkspacesApi.update(workspaceId, { status: "archived" }),
    onSuccess: (workspace) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(workspace.id), workspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.closeReadiness(workspace.id) });
      pushToast({
        title: currentStatus === "cleanup_failed"
          ? t("executionWorkspaceClose.toast.closeRetried", { defaultValue: "Workspace close retried" })
          : t("executionWorkspaceClose.toast.closed", { defaultValue: "Workspace closed" }),
        tone: "success",
      });
      onOpenChange(false);
      onClosed?.(workspace);
    },
    onError: (error) => {
      pushToast({
        title: t("executionWorkspaceClose.toast.closeFailed", { defaultValue: "Failed to close workspace" }),
        body: error instanceof Error ? error.message : t("executionWorkspaceClose.toast.unknownError", { defaultValue: "Unknown error" }),
        tone: "error",
      });
    },
  });

  const readiness = readinessQuery.data ?? null;
  const blockingIssues = readiness?.linkedIssues.filter((issue) => !issue.isTerminal) ?? [];
  const otherLinkedIssues = readiness?.linkedIssues.filter((issue) => issue.isTerminal) ?? [];
  const confirmDisabled =
    currentStatus === "archived" ||
    closeWorkspace.isPending ||
    readinessQuery.isLoading ||
    readiness == null ||
    readiness.state === "blocked";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!closeWorkspace.isPending) onOpenChange(nextOpen);
    }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription className="break-words">
            {t("executionWorkspaceClose.descriptionBefore", { defaultValue: "Archive" })}{" "}
            <span className="font-medium text-foreground">{workspaceName}</span>{" "}
            {t("executionWorkspaceClose.descriptionAfter", { defaultValue: "and clean up any owned workspace artifacts. Workcell keeps the workspace record and issue history, but removes it from active workspace views." })}
          </DialogDescription>
        </DialogHeader>

        {readinessQuery.isLoading ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("executionWorkspaceClose.checkingSafe", { defaultValue: "Checking whether this workspace is safe to close..." })}
          </div>
        ) : readinessQuery.error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {readinessQuery.error instanceof Error ? readinessQuery.error.message : t("executionWorkspaceClose.inspectFailed", { defaultValue: "Failed to inspect workspace close readiness." })}
          </div>
        ) : readiness ? (
          <div className="space-y-4">
            <div className={`rounded-xl border px-4 py-3 text-sm ${readinessTone(readiness.state)}`}>
              <div className="font-medium">
                {readiness.state === "blocked"
                  ? t("executionWorkspaceClose.state.blocked", { defaultValue: "Close is blocked" })
                  : readiness.state === "ready_with_warnings"
                    ? t("executionWorkspaceClose.state.warnings", { defaultValue: "Close is allowed with warnings" })
                    : t("executionWorkspaceClose.state.ready", { defaultValue: "Close is ready" })}
              </div>
              <div className="mt-1 text-xs opacity-80">
                {readiness.isSharedWorkspace
                  ? t("executionWorkspaceClose.detail.shared", { defaultValue: "This is a shared workspace session. Archiving it removes this session record but keeps the underlying project workspace." })
                  : readiness.git?.workspacePath && readiness.git.repoRoot && readiness.git.workspacePath !== readiness.git.repoRoot
                    ? t("executionWorkspaceClose.detail.ownCheckout", { defaultValue: "This execution workspace has its own checkout path and can be archived independently." })
                    : readiness.isProjectPrimaryWorkspace
                      ? t("executionWorkspaceClose.detail.projectPrimary", { defaultValue: "This execution workspace currently points at the project's primary workspace path." })
                      : t("executionWorkspaceClose.detail.disposable", { defaultValue: "This workspace is disposable and can be archived." })}
              </div>
            </div>

            {blockingIssues.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("executionWorkspaceClose.section.blockingIssues", { defaultValue: "Blocking issues" })}</h3>
                <div className="space-y-2">
                  {blockingIssues.map((issue) => (
                    <div key={issue.id} className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <Link to={issueUrl(issue)} className="min-w-0 break-words font-medium hover:underline">
                          {issue.identifier ?? issue.id} · {issue.title}
                        </Link>
                        <span className="text-xs text-muted-foreground">{issue.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {readiness.blockingReasons.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("executionWorkspaceClose.section.blockingReasons", { defaultValue: "Blocking reasons" })}</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {readiness.blockingReasons.map((reason) => (
                    <li key={reason} className="break-words rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive">
                      {reason}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {readiness.warnings.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("executionWorkspaceClose.section.warnings", { defaultValue: "Warnings" })}</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {readiness.warnings.map((warning) => (
                    <li key={warning} className="break-words rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                      {warning}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {readiness.git ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("executionWorkspaceClose.section.gitStatus", { defaultValue: "Git status" })}</h3>
                <div className="rounded-xl border border-border bg-background px-4 py-3 text-sm">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{t("executionWorkspaceClose.git.branch", { defaultValue: "Branch" })}</div>
                      <div className="font-mono text-xs">{readiness.git.branchName ?? t("executionWorkspaceClose.git.unknown", { defaultValue: "Unknown" })}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{t("executionWorkspaceClose.git.baseRef", { defaultValue: "Base ref" })}</div>
                      <div className="font-mono text-xs">{readiness.git.baseRef ?? t("executionWorkspaceClose.git.notSet", { defaultValue: "Not set" })}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{t("executionWorkspaceClose.git.mergedIntoBase", { defaultValue: "Merged into base" })}</div>
                      <div>{readiness.git.isMergedIntoBase == null ? t("executionWorkspaceClose.git.unknown", { defaultValue: "Unknown" }) : readiness.git.isMergedIntoBase ? t("executionWorkspaceClose.git.yes", { defaultValue: "Yes" }) : t("executionWorkspaceClose.git.no", { defaultValue: "No" })}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{t("executionWorkspaceClose.git.aheadBehind", { defaultValue: "Ahead / behind" })}</div>
                      <div>
                        {(readiness.git.aheadCount ?? 0).toString()} / {(readiness.git.behindCount ?? 0).toString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{t("executionWorkspaceClose.git.dirtyTracked", { defaultValue: "Dirty tracked files" })}</div>
                      <div>{readiness.git.dirtyEntryCount}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{t("executionWorkspaceClose.git.untracked", { defaultValue: "Untracked files" })}</div>
                      <div>{readiness.git.untrackedEntryCount}</div>
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {otherLinkedIssues.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("executionWorkspaceClose.section.otherLinkedIssues", { defaultValue: "Other linked issues" })}</h3>
                <div className="space-y-2">
                  {otherLinkedIssues.map((issue) => (
                    <div key={issue.id} className="rounded-xl border border-border bg-background px-4 py-3 text-sm">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <Link to={issueUrl(issue)} className="min-w-0 break-words font-medium hover:underline">
                          {issue.identifier ?? issue.id} · {issue.title}
                        </Link>
                        <span className="text-xs text-muted-foreground">{issue.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {readiness.runtimeServices.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("executionWorkspaceClose.section.runtimeServices", { defaultValue: "Attached runtime services" })}</h3>
                <div className="space-y-2">
                  {readiness.runtimeServices.map((service) => (
                    <div key={service.id} className="rounded-xl border border-border bg-background px-4 py-3 text-sm">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{service.serviceName}</span>
                        <span className="text-xs text-muted-foreground">{service.status} · {service.lifecycle}</span>
                      </div>
                      <div className="mt-1 break-words text-xs text-muted-foreground">
                        {service.url ?? service.command ?? service.cwd ?? t("executionWorkspaceClose.noAdditionalDetails", { defaultValue: "No additional details" })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t("executionWorkspaceClose.section.cleanupActions", { defaultValue: "Cleanup actions" })}</h3>
              <div className="space-y-2">
                {readiness.plannedActions.map((action, index) => (
                  <div key={`${action.kind}-${index}`} className="rounded-xl border border-border bg-background px-4 py-3 text-sm">
                    <div className="font-medium">{action.label}</div>
                    <div className="mt-1 break-words text-muted-foreground">{action.description}</div>
                    {action.command ? (
                      <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-background px-3 py-2 font-mono text-xs text-foreground">
                        {action.command}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            {currentStatus === "cleanup_failed" ? (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">
                {t("executionWorkspaceClose.cleanupFailedNotice", { defaultValue: "Cleanup previously failed on this workspace. Retrying close will rerun the cleanup flow and update the workspace status if it succeeds." })}
              </div>
            ) : null}

            {currentStatus === "archived" ? (
              <div className="rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
                {t("executionWorkspaceClose.alreadyArchived", { defaultValue: "This workspace is already archived." })}
              </div>
            ) : null}

            {readiness.git?.repoRoot ? (
              <div className="break-words text-xs text-muted-foreground">
                {t("executionWorkspaceClose.repoRoot", { defaultValue: "Repo root:" })} <span className="font-mono break-all">{readiness.git.repoRoot}</span>
                {readiness.git.workspacePath ? (
                  <>
                    {" · "}{t("executionWorkspaceClose.workspacePath", { defaultValue: "Workspace path:" })} <span className="font-mono break-all">{readiness.git.workspacePath}</span>
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="text-xs text-muted-foreground">
              {t("executionWorkspaceClose.lastChecked", { defaultValue: "Last checked {{time}}", time: formatDateTime(new Date()) })}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={closeWorkspace.isPending}
          >
            {t("executionWorkspaceClose.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            variant={currentStatus === "cleanup_failed" ? "default" : "destructive"}
            onClick={() => closeWorkspace.mutate()}
            disabled={confirmDisabled}
          >
            {closeWorkspace.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
