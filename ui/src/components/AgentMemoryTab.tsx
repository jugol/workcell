import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Brain, Trash2, X, Plus, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/i18n";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import {
  agentMemoryApi,
  MEMORY_NODE_KINDS,
  type AgentMemoryNode,
  type MemoryNodeKind,
} from "../api/agent-memory";
import { GraphCanvas, type GraphCanvasNode, type GraphCanvasEdge } from "./GraphCanvas";

// WC-181 (slice 3): the per-agent memory graph view, mounted as the "memory" tab
// on AgentDetail. Reads the agent's whole { nodes, edges } graph and renders it
// with the shared GraphCanvas; nodes are coloured by `kind`. Selecting a node
// opens a detail panel (label, kind, full content, metadata, provenance run) with
// a Forget action. A board user may forget any node within their company — the
// route enforces scope, so the UI just calls deleteMemoryNode on the session.

// Per-kind tint. Semantic-token surfaces with a coloured border/text accent —
// never a raw status colour (kinds are their own taxonomy, not entity status).
const KIND_TINT: Record<MemoryNodeKind, string> = {
  fact: "border-blue-500/40 bg-blue-50/60 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300",
  preference:
    "border-violet-500/40 bg-violet-50/60 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300",
  entity:
    "border-emerald-500/40 bg-emerald-50/60 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
  decision:
    "border-amber-500/40 bg-amber-50/60 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
  todo: "border-cyan-500/40 bg-cyan-50/60 text-cyan-700 dark:bg-cyan-950/30 dark:text-cyan-300",
  other: "border-border bg-muted/40 text-muted-foreground",
};
const DEFAULT_TINT = "border-border bg-muted/40 text-muted-foreground";

function tintFor(kind: string): string {
  return KIND_TINT[kind as MemoryNodeKind] ?? DEFAULT_TINT;
}

export function AgentMemoryTab({
  agentId,
  companyId: _companyId,
  agentRouteId,
}: {
  agentId: string;
  /** Reserved for future company-scoped affordances; route enforces scope. */
  companyId?: string;
  /** Route ref used to build provenance run links; falls back to agentId. */
  agentRouteId?: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.agents.memory(agentId),
    queryFn: () => agentMemoryApi.getMemoryGraph(agentId),
  });

  const nodes = query.data?.nodes ?? [];
  const edges = query.data?.edges ?? [];

  const kindLabel = (kind: string) =>
    t(`agentMemory.kind.${kind}`, { defaultValue: kind });

  const graphNodes: GraphCanvasNode[] = useMemo(
    () =>
      [...nodes]
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label))
        .map((n) => ({
          id: n.id,
          label: n.label,
          badge: kindLabel(n.kind),
          tint: tintFor(n.kind),
        })),
    // kindLabel is derived from t(); nodes identity drives recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes],
  );

  const graphEdges: GraphCanvasEdge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        fromNodeId: e.fromNodeId,
        toNodeId: e.toNodeId,
        label: e.relation,
      })),
    [edges],
  );

  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  if (query.isLoading) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="agent-memory-loading">
        {t("agentMemory.loading", { defaultValue: "Loading memory…" })}
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="text-sm text-destructive">
        {t("agentMemory.loadError", { defaultValue: "Could not load this agent's memory." })}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="agent-memory-tab">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h2 className="text-sm font-semibold">
            {t("agentMemory.heading", { defaultValue: "Memory" })}
          </h2>
          <span className="text-xs text-muted-foreground">{nodes.length}</span>
        </div>
        <AddMemoryButton agentId={agentId} />
      </div>

      {nodes.length === 0 ? (
        <EmptyMemory />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <GraphCanvas
            nodes={graphNodes}
            edges={graphEdges}
            selectedNodeId={selectedId}
            onNodeClick={setSelectedId}
            onBackgroundClick={() => setSelectedId(null)}
            className="h-[28rem]"
            aria-label={t("agentMemory.graphLabel", { defaultValue: "Agent memory graph" })}
          />
          {selected ? (
            <MemoryDetail
              node={selected}
              agentId={agentId}
              agentRouteId={agentRouteId ?? agentId}
              onForgotten={() => setSelectedId(null)}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="hidden rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground lg:block">
              {t("agentMemory.selectHint", {
                defaultValue: "Select a memory to see its details.",
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );

  function EmptyMemory() {
    return (
      <div
        data-testid="agent-memory-empty"
        className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center"
      >
        <Brain className="h-8 w-8 text-muted-foreground/60" />
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("agentMemory.empty", {
            defaultValue:
              "This agent has no memories yet — it builds them on its own as it works.",
          })}
        </p>
      </div>
    );
  }
}

function MemoryDetail({
  node,
  agentId,
  agentRouteId,
  onForgotten,
  onClose,
}: {
  node: AgentMemoryNode;
  agentId: string;
  agentRouteId: string;
  onForgotten: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const forget = useMutation({
    mutationFn: () => agentMemoryApi.deleteMemoryNode(agentId, node.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.memory(agentId) });
      onForgotten();
    },
  });

  const kindLabel = t(`agentMemory.kind.${node.kind}`, { defaultValue: node.kind });
  const metadataEntries = Object.entries(node.metadata ?? {});

  return (
    <aside
      data-testid="agent-memory-detail"
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Badge
            variant="outline"
            className={`px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide ${tintFor(node.kind)}`}
          >
            {kindLabel}
          </Badge>
          <h3 className="text-sm font-semibold leading-tight break-words">{node.label}</h3>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label={t("agentMemory.close", { defaultValue: "Close" })}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">
          {t("agentMemory.content", { defaultValue: "Content" })}
        </span>
        <p className="whitespace-pre-wrap break-words text-sm">{node.content}</p>
      </div>

      {metadataEntries.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">
            {t("agentMemory.metadata", { defaultValue: "Metadata" })}
          </span>
          <dl className="space-y-0.5">
            {metadataEntries.map(([key, value]) => (
              <div key={key} className="flex items-start justify-between gap-3 text-xs">
                <dt className="font-mono text-muted-foreground">{key}</dt>
                <dd className="break-all text-right font-mono">
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">
          {t("agentMemory.provenance", { defaultValue: "Source run" })}
        </span>
        {node.sourceRunId ? (
          <Link
            to={`/agents/${agentRouteId}/runs/${node.sourceRunId}`}
            className="inline-flex items-center gap-1 text-xs font-mono text-foreground hover:underline"
          >
            {node.sourceRunId.slice(0, 8)}
            <ExternalLink className="h-3 w-3" />
          </Link>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("agentMemory.noProvenance", { defaultValue: "—" })}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-[10px] text-muted-foreground">
          {t("agentMemory.updated", { defaultValue: "Updated" })} {relativeTime(node.updatedAt)}
        </span>
        {confirming ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setConfirming(false)}
              disabled={forget.isPending}
            >
              {t("agentMemory.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              variant="destructive"
              size="xs"
              onClick={() => forget.mutate()}
              disabled={forget.isPending}
            >
              {forget.isPending
                ? t("agentMemory.forgetting", { defaultValue: "Forgetting…" })
                : t("agentMemory.confirmForget", { defaultValue: "Confirm forget" })}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            {t("agentMemory.forget", { defaultValue: "Forget" })}
          </Button>
        )}
      </div>
      {forget.isError && (
        <p className="text-xs text-destructive">
          {t("agentMemory.forgetError", { defaultValue: "Could not forget this memory." })}
        </p>
      )}
    </aside>
  );
}

// Tiny optional board affordance: kind + label + content → upsert. Native
// <select> keeps it test-friendly and consistent with other lightweight forms.
function AddMemoryButton({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<MemoryNodeKind>("fact");
  const [label, setLabel] = useState("");
  const [content, setContent] = useState("");

  const upsert = useMutation({
    mutationFn: () =>
      agentMemoryApi.upsertMemoryNode(agentId, { kind, label: label.trim(), content: content.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.memory(agentId) });
      setLabel("");
      setContent("");
      setOpen(false);
    },
  });

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t("agentMemory.add", { defaultValue: "Add memory" })}
      </Button>
    );
  }

  const canSubmit = label.trim().length > 0 && content.trim().length > 0 && !upsert.isPending;

  return (
    <form
      data-testid="agent-memory-add-form"
      className="flex w-full max-w-md flex-col gap-2 rounded-lg border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) upsert.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as MemoryNodeKind)}
          aria-label={t("agentMemory.kindLabel", { defaultValue: "Kind" })}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {MEMORY_NODE_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`agentMemory.kind.${k}`, { defaultValue: k })}
            </option>
          ))}
        </select>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("agentMemory.labelPlaceholder", { defaultValue: "Label" })}
          className="h-8 text-xs"
        />
      </div>
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={t("agentMemory.contentPlaceholder", { defaultValue: "What to remember…" })}
        className="min-h-16 text-xs"
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>
          {t("agentMemory.cancel", { defaultValue: "Cancel" })}
        </Button>
        <Button type="submit" size="xs" disabled={!canSubmit}>
          {upsert.isPending
            ? t("agentMemory.saving", { defaultValue: "Saving…" })
            : t("agentMemory.save", { defaultValue: "Remember" })}
        </Button>
      </div>
      {upsert.isError && (
        <p className="text-xs text-destructive">
          {t("agentMemory.saveError", { defaultValue: "Could not save this memory." })}
        </p>
      )}
    </form>
  );
}
