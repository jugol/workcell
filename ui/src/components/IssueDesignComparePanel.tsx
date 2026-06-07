import { useQuery } from "@tanstack/react-query";
import { Columns2 } from "lucide-react";
import { isDesignWorkProductType, type IssueWorkProduct } from "@workcell/shared";
import { useTranslation } from "@/i18n";
import { queryKeys } from "../lib/queryKeys";
import { issuesApi } from "../api/issues";

// WC-183c / (b)③: the VISIBLE 복각 verification. When an issue carries an
// extracted design-system artifact (a design-type work product whose
// `metadata.kind === "design_system"`, produced by POST /issues/:id/design-system),
// this panel sits next to IssueDesignReviewPanel and shows a side-by-side of that
// design-system reference and the reproduced screen 시안 the designer attached via
// `design_attach`. It shares the work-products query cache with the review panel
// (same query key) and renders NOTHING on ordinary issues with no design system.

function comparePreviewTitle(
  t: ReturnType<typeof useTranslation>["t"],
  title: string,
) {
  return t("issueDesignCompare.previewTitle", {
    defaultValue: "Design preview: {{title}}",
    title,
  });
}

function ComparePreview({
  url,
  title,
  testId,
}: {
  url: string | null;
  title: string;
  testId: string;
}) {
  const { t } = useTranslation();
  if (!url) {
    return (
      <p className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">
        {t("issueDesignCompare.noPreview", {
          defaultValue: "No preview available for this design.",
        })}
      </p>
    );
  }
  return (
    <iframe
      // Sandboxed: render the preview without granting it any privileges
      // (no scripts, same-origin, forms, popups, or top-level navigation).
      sandbox=""
      src={url}
      title={comparePreviewTitle(t, title)}
      className="h-64 w-full rounded-md border border-border bg-background"
      data-testid={testId}
    />
  );
}

// Most-recent-first by createdAt; falls back to array order when timestamps tie.
function mostRecent(items: IssueWorkProduct[]): IssueWorkProduct | null {
  if (items.length === 0) return null;
  return items.reduce((latest, item) =>
    new Date(item.createdAt).getTime() >= new Date(latest.createdAt).getTime()
      ? item
      : latest,
  );
}

function isDesignSystemArtifact(wp: IssueWorkProduct): boolean {
  const metadata = wp.metadata as Record<string, unknown> | null;
  return metadata?.["kind"] === "design_system";
}

// Trivial token summary (color swatch count + font-size count) when the
// design-system metadata exposes tokens in the expected shape; else null.
function tokenSummary(wp: IssueWorkProduct): { colors: number; fontSizes: number } | null {
  const metadata = wp.metadata as Record<string, unknown> | null;
  const tokens = metadata?.["tokens"];
  if (typeof tokens !== "object" || tokens === null) return null;
  const tokenRecord = tokens as Record<string, unknown>;
  const colors = tokenRecord["colors"];
  const fontSizes = tokenRecord["fontSizes"];
  const colorCount = Array.isArray(colors)
    ? colors.length
    : typeof colors === "object" && colors !== null
      ? Object.keys(colors).length
      : 0;
  const fontSizeCount = Array.isArray(fontSizes)
    ? fontSizes.length
    : typeof fontSizes === "object" && fontSizes !== null
      ? Object.keys(fontSizes).length
      : 0;
  if (colorCount === 0 && fontSizeCount === 0) return null;
  return { colors: colorCount, fontSizes: fontSizeCount };
}

export function IssueDesignComparePanel({ issueId }: { issueId: string }) {
  const { t } = useTranslation();

  // Reuse the SAME query key as IssueDesignReviewPanel so both panels share one
  // cache entry and refetch together.
  const workProductsQueryKey = queryKeys.issues.workProducts(issueId);
  const { data: workProducts } = useQuery({
    queryKey: workProductsQueryKey,
    queryFn: () => issuesApi.listWorkProducts(issueId),
    enabled: !!issueId,
  });

  const designs = (workProducts ?? []).filter((wp) => isDesignWorkProductType(wp.type));
  const designSystem = mostRecent(designs.filter(isDesignSystemArtifact));

  // This panel is ONLY for the 복각/replication workflow: with no extracted
  // design-system artifact there is nothing to compare against, so render nothing
  // and keep ordinary issues uncluttered.
  if (!designSystem) return null;

  // The reproduced screen 시안 = the isPrimary design that is NOT the design-system
  // artifact; fall back to the most recent non-design-system design.
  const nonDesignSystem = designs.filter((wp) => wp.id !== designSystem.id && !isDesignSystemArtifact(wp));
  const reproduced =
    nonDesignSystem.find((wp) => wp.isPrimary === true) ?? mostRecent(nonDesignSystem);

  const summary = tokenSummary(designSystem);

  return (
    <section
      className="space-y-3 rounded-lg border border-border p-3"
      data-testid="design-compare-panel"
    >
      <header className="flex items-start gap-2">
        <Columns2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-500 dark:text-violet-300" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">
            {t("issueDesignCompare.title", { defaultValue: "Reproduction — design-system check" })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("issueDesignCompare.subtitle", {
              defaultValue:
                "Compare the extracted design system (the original baseline) against the reproduced screen mockup side by side.",
            })}
          </p>
          {summary ? (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="design-compare-token-summary">
              {t("issueDesignCompare.tokenSummary", {
                defaultValue: "{{colors}} colors · {{fontSizes}} font sizes",
                colors: summary.colors,
                fontSizes: summary.fontSizes,
              })}
            </p>
          ) : null}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-2" data-testid="design-compare-system">
          <p className="text-xs font-medium text-muted-foreground">
            {t("issueDesignCompare.systemLabel", {
              defaultValue: "Extracted design system (baseline)",
            })}
          </p>
          <p className="min-w-0 truncate text-sm font-medium" title={designSystem.title}>
            {designSystem.title}
          </p>
          <ComparePreview
            url={designSystem.url}
            title={designSystem.title}
            testId="design-compare-system-preview"
          />
        </div>

        <div className="space-y-2" data-testid="design-compare-reproduced">
          <p className="text-xs font-medium text-muted-foreground">
            {t("issueDesignCompare.reproducedLabel", {
              defaultValue: "Reproduced screen mockup",
            })}
          </p>
          {reproduced ? (
            <>
              <p className="min-w-0 truncate text-sm font-medium" title={reproduced.title}>
                {reproduced.title}
              </p>
              <ComparePreview
                url={reproduced.url}
                title={reproduced.title}
                testId="design-compare-reproduced-preview"
              />
            </>
          ) : (
            <p
              className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground"
              data-testid="design-compare-reproduced-empty"
            >
              {t("issueDesignCompare.reproducedEmpty", {
                defaultValue:
                  "No reproduced mockup yet — once a designer reproduces a screen against this design system, it appears here.",
              })}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
