import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Share2, ArrowRight, ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { knowledgeGraphApi } from "../api/knowledge-graph";
import { useTranslation } from "@/i18n";

// WC-123 (D12 S5): the first user-visible surface of the Knowledge Graph.
// Mounted on IssueDetail — shows the issue's 1-hop connections (related issues,
// code symbols, decisions, runs, etc.) joined with the edge kind + direction.
// Read-only and GRACEFUL: renders nothing when the issue is not yet mirrored
// into the graph or has no connections, so it never adds empty-state noise.

const KIND_TINT: Record<string, string> = {
  issue: "border-blue-500/40 bg-blue-50/60 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300",
  code: "border-emerald-500/40 bg-emerald-50/60 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
  decision:
    "border-violet-500/40 bg-violet-50/60 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300",
  plan_section:
    "border-amber-500/40 bg-amber-50/60 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
  run: "border-cyan-500/40 bg-cyan-50/60 text-cyan-700 dark:bg-cyan-950/30 dark:text-cyan-300",
};
const DEFAULT_TINT = "border-border bg-muted/40 text-muted-foreground";

export function KnowledgeGraphPanel({
  companyId,
  issueId,
}: {
  companyId: string;
  issueId: string;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["knowledge-graph", "issue", companyId, issueId],
    queryFn: () => knowledgeGraphApi.issueNeighborhood(companyId, issueId),
  });

  const data = query.data;
  const connections = data?.connections ?? [];
  // Quiet when the issue is not in the graph or has no connections — the panel
  // appears only where it actually carries information.
  if (!data || !data.node || connections.length === 0) return null;

  const kindLabel = (kind: string) =>
    t(`knowledgeGraph.kind.${kind}`, { defaultValue: kind.replace(/_/g, " ") });
  const edgeLabel = (edgeKind: string) =>
    t(`knowledgeGraph.edge.${edgeKind}`, { defaultValue: edgeKind.replace(/_/g, " ") });

  // Stable, scannable ordering: by kind then label.
  const sorted = [...connections].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label),
  );

  return (
    <section
      data-testid="knowledge-graph-panel"
      className="space-y-3 rounded-md border border-border p-3"
    >
      <header className="flex items-center gap-2">
        <Share2 className="h-4 w-4 shrink-0 text-sky-500 dark:text-sky-300" />
        <h3 className="text-sm font-semibold">
          {t("knowledgeGraph.heading", { defaultValue: "Knowledge graph" })}
        </h3>
        <span className="text-xs text-muted-foreground">{connections.length}</span>
      </header>
      <ul className="space-y-1">
        {sorted.map((c) => (
          <li
            key={`${c.id}:${c.edgeKind}:${c.direction}`}
            className="flex items-center gap-2 text-xs"
          >
            <Badge
              variant="outline"
              className={`shrink-0 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide ${
                KIND_TINT[c.kind] ?? DEFAULT_TINT
              }`}
            >
              {kindLabel(c.kind)}
            </Badge>
            {c.kind === "issue" ? (
              <Link
                to={`/issues/${c.entityRef}`}
                className="truncate font-medium text-foreground hover:underline"
              >
                {c.label}
              </Link>
            ) : (
              <span className="truncate font-medium text-foreground">{c.label}</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
              {c.direction === "out" ? (
                <ArrowRight className="h-3 w-3" aria-label={t("knowledgeGraph.direction.out", { defaultValue: "to" })} />
              ) : (
                <ArrowLeft className="h-3 w-3" aria-label={t("knowledgeGraph.direction.in", { defaultValue: "from" })} />
              )}
              {edgeLabel(c.edgeKind)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
