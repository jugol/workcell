import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, ExternalLink, FileText, Plus, Wrench } from "lucide-react";
import type { DesignFlow } from "@workcell/shared";
import { Link } from "@/lib/router";
import { designFlowApi } from "../api/design-flow";
import { issuesApi } from "../api/issues";
import { MarkdownBody } from "../components/MarkdownBody";
import { EmptyState } from "../components/EmptyState";
import { toDisplayPreviewUrl } from "../lib/previewUrl";
import { cn } from "../lib/utils";
import type { FlowScope } from "../components/design/FlowDashboard";

// R4: a screen's "화면 기획" detail — reached by clicking a node in the flow. The
// screen and its plan are a PAIR: the pure 시안 (mockup) shows WHAT the screen is,
// the plan describes it (purpose, states, interactions). The mockup preview comes
// from the (cached) flow node; the plan body from getScreenPlan.
export function ScreenPlanDetail({
  companyId,
  scope,
  screenKey,
  onBack,
  onOpenScreen,
}: {
  companyId: string;
  scope: FlowScope;
  screenKey: string;
  onBack: () => void;
  // Jump to another screen's plan (used by the flow-link list below).
  onOpenScreen?: (screenKey: string) => void;
}) {
  const { t } = useTranslation();
  const scopeId = scope.kind === "project" ? scope.projectId : `company:${companyId}`;

  const flowQuery = useQuery({
    queryKey: ["design-flow", scopeId],
    queryFn: () =>
      scope.kind === "project"
        ? designFlowApi.getForProject(scope.projectId)
        : designFlowApi.getForCompany(companyId),
    enabled: Boolean(companyId),
  });
  const planQuery = useQuery({
    queryKey: ["design-screen-plan", scopeId, screenKey],
    queryFn: () =>
      scope.kind === "project"
        ? designFlowApi.getScreenPlanForProject(scope.projectId, screenKey)
        : designFlowApi.getScreenPlanForCompany(companyId, screenKey),
    enabled: Boolean(companyId),
  });

  const flow: DesignFlow | undefined = flowQuery.data;
  const screen = useMemo(
    () => flow?.screens.find((s) => s.screenKey === screenKey) ?? null,
    [flow, screenKey],
  );
  const plan = planQuery.data ?? null;
  const screenName = screen?.screenName ?? plan?.screenName ?? screenKey;
  const previewSrc = screen ? toDisplayPreviewUrl(screen.previewUrl) : null;

  // R4: this screen's navigation links, spelled out so the connections are legible
  // even when the flow arrows tangle. Resolve target keys to display names.
  const flowLinks = useMemo(() => {
    const links = flow?.links ?? [];
    const nameByKey = new Map((flow?.screens ?? []).map((s) => [s.screenKey, s.screenName]));
    const name = (k: string) => nameByKey.get(k) ?? k;
    return {
      out: links.filter((l) => l.fromScreenKey === screenKey).map((l) => ({ key: l.toScreenKey, name: name(l.toScreenKey), label: l.label })),
      incoming: links.filter((l) => l.toScreenKey === screenKey).map((l) => ({ key: l.fromScreenKey, name: name(l.fromScreenKey), label: l.label })),
    };
  }, [flow, screenKey]);

  // Spin up a revision issue for THIS screen — even an already-finalized screen
  // can need a fix. The issue lands in the project with guidance to re-author the
  // 시안 under the SAME screenKey (so it supersedes this screen in the blueprint).
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<{ id: string; identifier: string | null } | null>(null);
  const reviseIssue = useMutation({
    mutationFn: () =>
      issuesApi.create(companyId, {
        title: t("screenPlan.reviseIssueTitle", { defaultValue: "[{{screenName}}] Screen revision", screenName }),
        description:
          t("screenPlan.reviseIssueDescription", {
            defaultValue:
              "Revising the 「{{screenName}}」 screen (`screenKey: {{screenKey}}`) of the overall app plan.\n\n" +
              "## Revision request\n{{request}}\n\n" +
              "## Guide\n" +
              "- Since this is an edit to an existing screen, redraw and replace the mockup under the **same screenKey (`{{screenKey}}`)** (do not bake version/issue ID into the screenKey).\n" +
              "- The mockup HTML is the pure screen; write spec, states, and interactions in the screen plan (planMarkdown).\n" +
              "- Once the board approves, the previous version of this screen is cleaned up automatically.",
            screenName,
            screenKey,
            request: note.trim() || t("screenPlan.reviseIssueRequestPlaceholder", { defaultValue: "(Please describe what to fix)" }),
          }),
        status: "backlog",
        priority: "medium",
        workMode: "standard",
        ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
      }),
    onSuccess: (issue) => {
      setCreated({ id: issue.id, identifier: issue.identifier ?? null });
      setNote("");
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
  });

  return (
    <div className="space-y-4" data-testid="screen-plan-detail">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {t("screenPlan.backToFlow", { defaultValue: "Back to flow" })}
      </button>

      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">{screenName}</h2>
        {screen ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium",
              screen.approved ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600",
            )}
          >
            {screen.approved ? t("screenPlan.statusApproved", { defaultValue: "Approved" }) : t("screenPlan.statusInReview", { defaultValue: "In review" })}
          </span>
        ) : null}
        <code className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{screenKey}</code>
      </header>

      {/* Revise this screen — create a fix issue even for a finalized screen */}
      <section className="rounded-xl border border-border bg-card p-3" data-testid="screen-plan-revise">
        {created ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Check className="h-4 w-4 shrink-0 text-emerald-500" />
            <span>{t("screenPlan.reviseIssueCreated", { defaultValue: "Revision issue created (backlog)." })}</span>
            <Link
              to={`/issues/${created.identifier ?? created.id}`}
              className="font-medium text-primary hover:underline"
            >
              {created.identifier
                ? t("screenPlan.openIssueWithId", { defaultValue: "Open {{identifier}}", identifier: created.identifier })
                : t("screenPlan.openIssue", { defaultValue: "Open issue" })}{" "}
              →
            </Link>
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              {t("screenPlan.createAnother", { defaultValue: "Create another" })}
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              reviseIssue.mutate();
            }}
            className="space-y-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-sm font-semibold">{t("screenPlan.reviseSectionTitle", { defaultValue: "Revision issue for this screen" })}</span>
              <span className="text-xs text-muted-foreground">{t("screenPlan.reviseSectionHint", { defaultValue: "Even for a finalized screen, create an issue here whenever something needs fixing." })}</span>
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("screenPlan.reviseNotePlaceholder", { defaultValue: "What should be fixed? (Optional — leave empty to create with the title only)" })}
              rows={2}
              className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={reviseIssue.isPending}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" /> {reviseIssue.isPending ? t("screenPlan.creating", { defaultValue: "Creating…" }) : t("screenPlan.createReviseIssue", { defaultValue: "Create revision issue" })}
              </button>
              {reviseIssue.isError ? (
                <span className="text-xs text-destructive">{t("screenPlan.createFailed", { defaultValue: "Creation failed — please try again." })}</span>
              ) : null}
            </div>
          </form>
        )}
      </section>

      {/* R4: 화면 이동 — this screen's links, spelled out + click-through */}
      {flowLinks.out.length > 0 || flowLinks.incoming.length > 0 ? (
        <section className="rounded-xl border border-border bg-muted/20 p-3" data-testid="screen-plan-links">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("screenPlan.navigationHeading", { defaultValue: "Navigation" })}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              { title: t("screenPlan.linksOutgoing", { defaultValue: "Goes from here · {{count}}", count: flowLinks.out.length }), rows: flowLinks.out, dir: "out" as const },
              { title: t("screenPlan.linksIncoming", { defaultValue: "Comes into here · {{count}}", count: flowLinks.incoming.length }), rows: flowLinks.incoming, dir: "in" as const },
            ]).map((col) => (
              <div key={col.dir}>
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">{col.title}</p>
                {col.rows.length ? (
                  <ul className="space-y-0.5">
                    {col.rows.map((l, i) => (
                      <li key={`${col.dir}${i}`}>
                        <button
                          type="button"
                          onClick={() => onOpenScreen?.(l.key)}
                          disabled={!onOpenScreen}
                          className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
                        >
                          {col.dir === "out" ? (
                            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary" />
                          ) : (
                            <ArrowLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate font-medium group-hover:underline">{l.name}</span>
                          {l.label ? <span className="truncate text-xs text-muted-foreground">· {l.label}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-2 text-xs text-muted-foreground">{t("screenPlan.linksNone", { defaultValue: "None" })}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* The pure screen (시안) */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("screenPlan.mockupHeading", { defaultValue: "Screen (mockup)" })}</h3>
          <div className="overflow-hidden rounded-xl border border-border bg-white" style={{ height: "60vh" }}>
            {previewSrc ? (
              <iframe sandbox="" src={previewSrc} title={screenName} className="h-full w-full" />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t("screenPlan.noPreview", { defaultValue: "No preview" })}
              </div>
            )}
          </div>
          {previewSrc ? (
            <a
              href={previewSrc}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {t("screenPlan.openInNewTab", { defaultValue: "Open in new tab" })} <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </section>

        {/* The screen plan (화면 기획) */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("screenPlan.planHeading", { defaultValue: "Screen plan" })}</h3>
          {planQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("screenPlan.loading", { defaultValue: "Loading…" })}</p>
          ) : plan && plan.planMarkdown.trim() ? (
            <div className="rounded-xl border border-border bg-card p-4">
              <MarkdownBody>{plan.planMarkdown}</MarkdownBody>
            </div>
          ) : (
            <EmptyState
              icon={FileText}
              message={t("screenPlan.planEmpty", { defaultValue: "There is no plan for this screen yet. Once the designer agent writes the screen plan along with the mockup, it will appear here." })}
            />
          )}
        </section>
      </div>
    </div>
  );
}
