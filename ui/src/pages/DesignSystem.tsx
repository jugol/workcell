import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Palette, ExternalLink, Layers, FileImage, Trash2 } from "lucide-react";
import { designArtifactsApi, type DesignArtifact } from "../api/design-artifacts";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { cn } from "../lib/utils";
import { useTranslation } from "@/i18n";

// WC-191/194: the project's Design System (source of truth) window — an
// always-available sidebar page so the authoritative design can be checked any
// time. Two tabs:
//   • 디자인 시스템 — the CURRENT authoritative design per screen (approved +
//     primary if present, else newest), rendered large via its preview.
//   • 산출물 — a compact catalog of EVERY screen's current design. Superseded
//     versions are hard-deleted server-side on approval (WC-194), so this is a
//     clean one-card-per-screen source-of-truth set. A manual delete control is
//     the escape hatch.

type TabKey = "system" | "artifacts";

interface Lineage {
  key: string;
  current: DesignArtifact;
  versions: DesignArtifact[];
}

// WC-199: only an explicit "v" version token (v2, " - v1.0") counts as a version
// suffix. A BARE trailing number is NOT a version marker — "Dashboard 2024",
// "Onboarding Step 2", "Report Q3 2024" are distinct screens, and stripping their
// trailing number used to collapse them into one lineage, HIDING real designs from
// the catalog (violates "every screen's design stays visible"). Same-screen
// versions are tracked primarily by identical title + recency anyway.
const VERSION_SUFFIX = /\s*[-–—]?\s*v\d+(?:\.\d+)*\s*$/i;

function lineageKey(a: DesignArtifact): string {
  const stripped = a.title.replace(VERSION_SUFFIX, "").trim();
  return (stripped || a.title).toLowerCase();
}

function lineageDisplay(a: DesignArtifact): string {
  return a.title.replace(VERSION_SUFFIX, "").trim() || a.title;
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
      label: t("designSystem.badge.approved", { defaultValue: "승인됨" }),
      cls: "border-emerald-500/45 bg-emerald-50/60 text-emerald-700 dark:border-emerald-300/35 dark:bg-emerald-400/10 dark:text-emerald-300",
    },
    needs_board_review: {
      label: t("designSystem.badge.review", { defaultValue: "검토 중" }),
      cls: "border-amber-500/45 bg-amber-50/60 text-amber-700 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300",
    },
    changes_requested: {
      label: t("designSystem.badge.changes", { defaultValue: "변경 요청" }),
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
      src={artifact.previewUrl}
      title={artifact.title}
      sandbox="allow-scripts allow-same-origin"
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
          {t("designSystem.openIssue", { defaultValue: "원본 이슈" })}
          <ExternalLink className="h-3 w-3" />
        </Link>
      ) : null}
    </div>
  );
}

export function DesignSystem() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>("system");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("designSystem.breadcrumb", { defaultValue: "디자인 시스템" }) },
    ]);
  }, [setBreadcrumbs, t]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["design-artifacts", "list", selectedCompanyId],
    queryFn: () => designArtifactsApi.listForCompany(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => designArtifactsApi.remove(id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: ["design-artifacts", "list", selectedCompanyId],
      });
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

  const lineages = useMemo<Lineage[]>(() => {
    const map = new Map<string, DesignArtifact[]>();
    for (const a of artifacts) {
      const k = lineageKey(a);
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

  if (isLoading) return <PageSkeleton />;

  if (error) {
    return (
      <EmptyState
        icon={Palette}
        message={t("designSystem.loadError", {
          defaultValue: "디자인 산출물을 불러오지 못했습니다. 다시 시도하세요.",
        })}
      />
    );
  }

  const isEmpty = artifacts.length === 0;

  function confirmDelete(a: DesignArtifact, remaining: number) {
    const base = t("designSystem.confirmDelete", {
      defaultValue: '"{{title}}" 디자인을 영구 삭제합니다. 되돌릴 수 없습니다. 계속할까요?',
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
              "이 화면에는 다른 버전 {{count}}개가 남아 있어, 삭제 후에도 카드는 사라지지 않고 다음 버전을 표시합니다.",
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
            {t("designSystem.title", { defaultValue: "디자인 시스템" })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("designSystem.description", {
              defaultValue:
                "이 프로젝트의 디자인 source of truth. 화면마다 현재 디자인 1개씩 — 새 버전이 승인되면 이전 버전은 자동으로 삭제됩니다.",
            })}
          </p>
        </div>
      </header>

      {actionError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      <div className="flex items-center gap-1 border-b border-border" role="tablist">
        <TabButton
          active={tab === "system"}
          onClick={() => setTab("system")}
          testid="design-system-tab-system"
          icon={<Palette className="h-3.5 w-3.5" />}
          label={t("designSystem.tab.system", { defaultValue: "디자인 시스템" })}
          count={lineages.length}
        />
        <TabButton
          active={tab === "artifacts"}
          onClick={() => setTab("artifacts")}
          testid="design-system-tab-artifacts"
          icon={<Layers className="h-3.5 w-3.5" />}
          label={t("designSystem.tab.artifacts", { defaultValue: "산출물" })}
          count={lineages.length}
        />
      </div>

      {isEmpty ? (
        <EmptyState
          icon={Palette}
          message={t("designSystem.empty", {
            defaultValue:
              "아직 디자인 산출물이 없습니다. 이슈에 디자인 에이전트를 할당하거나 시안을 첨부하면 여기에 나타납니다.",
          })}
        />
      ) : tab === "system" ? (
        <section className="space-y-6" data-testid="design-system-current">
          {lineages.map((lin) => (
            <article
              key={lin.key}
              className="overflow-hidden rounded-xl border border-border bg-card"
              data-testid="design-system-current-card"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">{lin.current.title}</h2>
                  <span className="rounded-full border border-primary/45 bg-primary/10 px-1.5 py-0 text-[10px] font-medium text-primary">
                    {t("designSystem.current", { defaultValue: "현재" })}
                  </span>
                  <ReviewBadge artifact={lin.current} />
                </div>
                <ArtifactMeta artifact={lin.current} />
              </div>
              <PreviewFrame artifact={lin.current} className="h-[560px]" />
            </article>
          ))}
        </section>
      ) : (
        // 산출물 — compact catalog: every screen's current design, one card each.
        <section data-testid="design-system-artifacts">
          <p className="mb-3 text-xs text-muted-foreground">
            {t("designSystem.catalogNote", {
              defaultValue:
                "화면별 현재 디자인 {{n}}건. 새 버전 승인 시 이전 버전은 자동 삭제됩니다.",
              n: lineages.length,
            })}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {lineages.map((lin) => (
              <article
                key={lin.key}
                className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
                data-testid="design-artifact-card"
              >
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="truncate text-xs font-medium" title={lineageDisplay(lin.current)}>
                    {lineageDisplay(lin.current)}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {lin.versions.length > 1 && (
                      <span
                        className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                        title={t("designSystem.versionCount", { defaultValue: "{{count}}개 버전", count: lin.versions.length })}
                        data-testid="design-version-count"
                      >
                        {lin.versions.length}v
                      </span>
                    )}
                    <ReviewBadge artifact={lin.current} />
                    <button
                      type="button"
                      data-testid="design-delete"
                      onClick={() => confirmDelete(lin.current, lin.versions.length - 1)}
                      disabled={deleteMut.isPending}
                      className="inline-flex items-center rounded-md border border-border p-1 text-muted-foreground transition hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      title={t("designSystem.delete", { defaultValue: "삭제" })}
                      aria-label={t("designSystem.delete", { defaultValue: "삭제" })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <PreviewFrame artifact={lin.current} className="h-48" />
                <div className="px-3 py-2">
                  <ArtifactMeta artifact={lin.current} />
                </div>
              </article>
            ))}
          </div>
        </section>
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
  count: number;
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
      <span className="text-xs text-muted-foreground">{count}</span>
    </button>
  );
}
