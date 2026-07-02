import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Palette, ExternalLink, Layers, FileImage, Trash2, Network, BookOpen } from "lucide-react";
import { effectiveScreenKey, screenDisplayName } from "@workcell/shared";
import { designArtifactsApi, type DesignArtifact } from "../api/design-artifacts";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { FlowDashboard } from "../components/design/FlowDashboard";
import { DesignGuideView } from "../components/design/DesignGuideView";
import { ScreenPlanDetail } from "./ScreenPlanDetail";
import { cn } from "../lib/utils";
import { toDisplayPreviewUrl } from "../lib/previewUrl";
import { useTranslation } from "@/i18n";

// Design-system redesign — the app's design source-of-truth window, three tabs:
//   • 가이드  (R1) — the canonical design guide: tokens auto-extracted from the
//     approved screens + a board-authored notes memo.
//   • 화면    (R2/R5) — one card per SCREEN (effectiveScreenKey); an issue can
//     hold many screens, and a screen's older versions collapse into the card.
//     Approving/promoting a screen hard-deletes only THAT screen's older
//     versions server-side; different screens coexist.
//   • 플로우  (R3/R4) — the wireframe flow: screens as nodes, declared
//     navigation as directed edges, editable by the board.

type TabKey = "guide" | "screens" | "flow";

interface ScreenGroup {
  key: string;
  current: DesignArtifact;
  versions: DesignArtifact[];
}

// Screen grouping reuses the SAME shared helper as the server (effectiveScreenKey
// = screenKey ?? title-lineage) so the catalog's "one card per screen" grouping
// and the server's screen-scoped supersession can never drift.
function screenKeyOf(a: DesignArtifact): string {
  return effectiveScreenKey({ screenKey: a.screenKey, title: a.title });
}

function screenNameOf(a: DesignArtifact): string {
  return screenDisplayName({ screenName: a.screenName, title: a.title });
}

const TYPE_LABELS: Record<string, string> = {
  mockup: "Mockup",
  design: "Design",
  ui_preview: "UI Preview",
  screenshot: "Screenshot",
  figma_frame: "Figma",
};

// Authoritative "current" of a screen: the approved primary if one exists,
// otherwise any primary, otherwise the newest version (versions are newest-first).
function pickCurrent(versions: DesignArtifact[]): DesignArtifact {
  return (
    versions.find((v) => v.isPrimary && v.reviewState === "approved") ??
    versions.find((v) => v.isPrimary) ??
    versions[0]!
  );
}

function ReviewBadge({ artifact }: { artifact: DesignArtifact }) {
  const { t } = useTranslation();
  const map: Record<string, { label: string; cls: string }> = {
    approved: {
      label: t("designSystem.badge.approved", { defaultValue: "Approved" }),
      cls: "border-emerald-500/45 bg-emerald-50/60 text-emerald-700 dark:border-emerald-300/35 dark:bg-emerald-400/10 dark:text-emerald-300",
    },
    needs_board_review: {
      label: t("designSystem.badge.review", { defaultValue: "In review" }),
      cls: "border-amber-500/45 bg-amber-50/60 text-amber-700 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300",
    },
    changes_requested: {
      label: t("designSystem.badge.changes", { defaultValue: "Changes requested" }),
      cls: "border-red-500/45 bg-red-50/60 text-red-700 dark:border-red-300/35 dark:bg-red-400/10 dark:text-red-300",
    },
  };
  const m = map[artifact.reviewState];
  if (!m) return null;
  return (
    <span className={cn("rounded-full border px-1.5 py-0 text-[10px] font-medium", m.cls)}>
      {m.label}
    </span>
  );
}

function PreviewFrame({
  artifact,
  className,
}: {
  artifact: DesignArtifact;
  className?: string;
}) {
  if (!artifact.previewUrl) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/20 text-xs text-muted-foreground",
          className,
        )}
      >
        <FileImage className="mr-1.5 h-3.5 w-3.5" />
        미리보기 URL 없음
      </div>
    );
  }
  return (
    <iframe
      src={toDisplayPreviewUrl(artifact.previewUrl) ?? artifact.previewUrl}
      title={artifact.title}
      // 시안 HTML is UNTRUSTED, agent-authored content. Keep this fully
      // sandboxed (no allow-scripts, no allow-same-origin): once previewUrl is a
      // same-origin /api/assets/.../content URL instead of a data: URL,
      // allow-same-origin would make this a live stored-XSS sink. The asset
      // response also sets a `sandbox` CSP (server/src/routes/assets.ts) — this
      // is defense-in-depth. Scripts are never needed to render a static mockup.
      sandbox=""
      className={cn("w-full rounded-md border border-border bg-card", className)}
      loading="lazy"
    />
  );
}

function ArtifactMeta({ artifact }: { artifact: DesignArtifact }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      <span className="rounded-sm border border-border px-1.5 py-0 font-medium uppercase tracking-wide">
        {TYPE_LABELS[artifact.type] ?? artifact.type}
      </span>
      {artifact.provider ? <span>· {artifact.provider}</span> : null}
      <span>· {new Date(artifact.updatedAt).toLocaleString()}</span>
      {artifact.issueId ? (
        <Link
          to={`/issues/${artifact.issueId}`}
          className="inline-flex items-center gap-0.5 text-primary hover:underline"
        >
          {t("designSystem.openIssue", { defaultValue: "Source issue" })}
          <ExternalLink className="h-3 w-3" />
        </Link>
      ) : null}
    </div>
  );
}

// Scope of the listing: the company-wide overview (default, sidebar page) or
// a single project's design source of truth (ProjectDetail "Design System" tab).
export type DesignSystemScope =
  | { kind: "company" }
  | { kind: "project"; projectId: string };

export function DesignSystem({
  scope = { kind: "company" },
}: {
  scope?: DesignSystemScope;
}) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // R2: the flow (app blueprint) is the primary, front-and-center view.
  const [tab, setTab] = useState<TabKey>("flow");
  const [actionError, setActionError] = useState<string | null>(null);
  // R4: when a flow node is clicked, swap the whole view for that screen's "화면
  // 기획" detail (the screen 시안 + its plan). Back returns to the flow.
  const [detailScreenKey, setDetailScreenKey] = useState<string | null>(null);

  const projectId = scope.kind === "project" ? scope.projectId : null;

  useEffect(() => {
    // In project scope the host page (ProjectDetail) owns the breadcrumb trail.
    if (projectId) return;
    setBreadcrumbs([
      { label: t("designSystem.breadcrumb", { defaultValue: "App Blueprint" }) },
    ]);
  }, [setBreadcrumbs, t, projectId]);

  const { data, isLoading } = useQuery({
    queryKey: projectId
      ? ["design-artifacts", "list", "project", projectId]
      : ["design-artifacts", "list", selectedCompanyId],
    queryFn: () =>
      projectId
        ? designArtifactsApi.listForProject(projectId)
        : designArtifactsApi.listForCompany(selectedCompanyId!),
    enabled: projectId ? true : Boolean(selectedCompanyId),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => designArtifactsApi.remove(id),
    onSuccess: () => {
      setActionError(null);
      // Deleting affects both the company-wide and project-scoped listings —
      // invalidate the whole design-artifacts family.
      queryClient.invalidateQueries({ queryKey: ["design-artifacts"] });
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : String(e)),
  });

  const artifacts = useMemo(
    () =>
      [...(data?.items ?? [])].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      ),
    [data],
  );

  const screenGroups = useMemo<ScreenGroup[]>(() => {
    const map = new Map<string, DesignArtifact[]>();
    for (const a of artifacts) {
      const k = screenKeyOf(a);
      const arr = map.get(k);
      if (arr) arr.push(a);
      else map.set(k, [a]);
    }
    return [...map.entries()].map(([key, versions]) => ({
      key,
      current: pickCurrent(versions),
      versions,
    }));
  }, [artifacts]);

  if (isLoading && tab === "screens") return <PageSkeleton />;

  const isEmpty = artifacts.length === 0;

  function confirmDelete(a: DesignArtifact, remaining: number) {
    const base = t("designSystem.confirmDelete", {
      defaultValue: 'Permanently delete the "{{title}}" design? This cannot be undone. Continue?',
      title: a.title,
    });
    // WC-202: when this screen has more versions, the card does NOT disappear —
    // it falls back to the next version. Say so up front so the delete isn't
    // surprising.
    const note =
      remaining > 0
        ? "\n\n" +
          t("designSystem.confirmDeleteMultiNote", {
            defaultValue:
              "This screen has {{count}} other version(s), so the card won't disappear after deletion — it shows the next version instead.",
            count: remaining,
          })
        : "";
    if (window.confirm(base + note)) deleteMut.mutate(a.id);
  }

  return (
    <div className="space-y-5 p-6" data-testid="design-system-page">
      <header className="flex items-start gap-3">
        <Palette className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
        <div className="min-w-0">
          <h1 className="text-xl font-bold">
            {t("designSystem.title", { defaultValue: "App Blueprint" })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("designSystem.description", {
              defaultValue:
                "The whole app's screen composition and plan at a glance. See how screens connect in the flow (drag to arrange, scroll to zoom), then click a screen to open its plan (the details). A 'screen' is the pure mockup; a 'screen plan' is the document that describes it — the two move as a pair.",
            })}
          </p>
        </div>
      </header>

      {actionError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {detailScreenKey && selectedCompanyId ? (
        <ScreenPlanDetail
          companyId={selectedCompanyId}
          scope={scope}
          screenKey={detailScreenKey}
          onBack={() => setDetailScreenKey(null)}
          onOpenScreen={setDetailScreenKey}
        />
      ) : (
        <>
      <div className="flex items-center gap-1 border-b border-border" role="tablist">
        <TabButton
          active={tab === "flow"}
          onClick={() => setTab("flow")}
          testid="design-system-tab-flow"
          icon={<Network className="h-3.5 w-3.5" />}
          label={t("designSystem.tab.flow", { defaultValue: "Flow" })}
        />
        <TabButton
          active={tab === "screens"}
          onClick={() => setTab("screens")}
          testid="design-system-tab-screens"
          icon={<Layers className="h-3.5 w-3.5" />}
          label={t("designSystem.tab.screens", { defaultValue: "Screens" })}
          count={screenGroups.length}
        />
        <TabButton
          active={tab === "guide"}
          onClick={() => setTab("guide")}
          testid="design-system-tab-guide"
          icon={<BookOpen className="h-3.5 w-3.5" />}
          label={t("designSystem.tab.guide", { defaultValue: "Guide" })}
        />
      </div>

      {tab === "guide" && selectedCompanyId ? (
        <DesignGuideView companyId={selectedCompanyId} scope={scope} />
      ) : tab === "flow" && selectedCompanyId ? (
        <FlowDashboard companyId={selectedCompanyId} scope={scope} onOpenScreen={setDetailScreenKey} />
      ) : tab === "screens" ? (
        isEmpty ? (
          <EmptyState
            icon={Palette}
            message={t("designSystem.empty", {
              defaultValue:
                "No screen mockups yet — assign a design agent to an issue or attach a mockup, and it shows up here.",
            })}
          />
        ) : (
          // 화면 — one card per SCREEN (effectiveScreenKey); a screen's older
          // versions collapse into its card. An issue can hold many screens.
          <section data-testid="design-system-screens">
            <p className="mb-3 text-xs text-muted-foreground">
              {t("designSystem.catalogNote", {
                defaultValue:
                  "{{n}} screens. Approving a new version of the same screen auto-cleans that screen's older versions; one issue can hold several screens.",
                n: screenGroups.length,
              })}
            </p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {screenGroups.map((group) => (
                <article
                  key={group.key}
                  className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
                  data-testid="design-screen-card"
                >
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="truncate text-xs font-medium" title={screenNameOf(group.current)}>
                      {screenNameOf(group.current)}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {group.versions.length > 1 && (
                        <span
                          className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                          title={t("designSystem.versionCount", { defaultValue: "{{count}} versions", count: group.versions.length })}
                          data-testid="design-version-count"
                        >
                          {group.versions.length}v
                        </span>
                      )}
                      <ReviewBadge artifact={group.current} />
                      <button
                        type="button"
                        data-testid="design-delete"
                        onClick={() => confirmDelete(group.current, group.versions.length - 1)}
                        disabled={deleteMut.isPending}
                        className="inline-flex items-center rounded-md border border-border p-1 text-muted-foreground transition hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                        title={t("designSystem.delete", { defaultValue: "Delete" })}
                        aria-label={t("designSystem.delete", { defaultValue: "Delete" })}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <PreviewFrame artifact={group.current} className="h-72" />
                  <div className="px-3 py-2">
                    <ArtifactMeta artifact={group.current} />
                  </div>
                </article>
              ))}
            </div>
          </section>
        )
      ) : null}
        </>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  icon,
  testid,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  icon: ReactNode;
  testid: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testid}
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
      {typeof count === "number" ? <span className="text-xs text-muted-foreground">{count}</span> : null}
    </button>
  );
}
