import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, ArrowRight, ExternalLink } from "lucide-react";
import { type DesignFlow } from "@workcell/shared";
import { designFlowApi } from "../../api/design-flow";
import { WireframeFlow } from "./WireframeFlow";
import { EmptyState } from "../EmptyState";
import { cn } from "../../lib/utils";
import { toDisplayPreviewUrl } from "../../lib/previewUrl";

// Design-system redesign (R3/R4): the wireframe FLOW DASHBOARD. Screens are
// nodes; declared navigation links are directed edges (label = the trigger,
// e.g. "로그인 버튼"). The board can add/remove links here. A linked-but-not-yet-
// designed target renders as a dashed "planned" stub node.
export type FlowScope = { kind: "company" } | { kind: "project"; projectId: string };

export function FlowDashboard({
  companyId,
  scope,
  onOpenScreen,
}: {
  companyId: string;
  scope: FlowScope;
  // R4: clicking a screen node opens its "화면 기획" detail.
  onOpenScreen?: (screenKey: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const queryKey = useMemo(
    () => ["design-flow", scope.kind === "project" ? scope.projectId : `company:${companyId}`],
    [scope, companyId],
  );

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () =>
      scope.kind === "project"
        ? designFlowApi.getForProject(scope.projectId)
        : designFlowApi.getForCompany(companyId),
    enabled: Boolean(companyId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const addLink = useMutation({
    mutationFn: (body: { fromScreenKey: string; toScreenKey: string; label?: string }) =>
      scope.kind === "project"
        ? designFlowApi.addLinkForProject(scope.projectId, body)
        : designFlowApi.addLinkForCompany(companyId, body),
    onSuccess: () => {
      setErr(null);
      setFrom("");
      setTo("");
      setLabel("");
      invalidate();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const removeLink = useMutation({
    mutationFn: (id: string) => designFlowApi.removeLink(companyId, id),
    onSuccess: () => {
      setErr(null);
      invalidate();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
  });

  // R5: persist a node's position on drag-end. WireframeFlow holds the dragged
  // position optimistically, so this just writes through + refreshes the cache.
  const setPosition = useMutation({
    mutationFn: ({ screenKey, x, y }: { screenKey: string; x: number; y: number }) =>
      scope.kind === "project"
        ? designFlowApi.setPositionForProject(scope.projectId, screenKey, { x, y })
        : designFlowApi.setPositionForCompany(companyId, screenKey, { x, y }),
    onSuccess: () => invalidate(),
    onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const flow: DesignFlow | undefined = data;

  const selectedScreen = flow?.screens.find((s) => s.screenKey === selected) ?? null;

  if (isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("flowDashboard.loadingFlow", { defaultValue: "Loading flow…" })}
      </div>
    );
  }

  if (!flow || (flow.screens.length === 0 && flow.links.length === 0)) {
    return (
      <EmptyState
        icon={ArrowRight}
        message={t("flowDashboard.emptyState", {
          defaultValue:
            "No screens yet. Attach a screen mockup to an issue and it will appear here as a wireframe flow.",
        })}
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="design-flow-dashboard">
      {err ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </p>
      ) : null}

      <div className="h-[72vh] min-h-[480px] overflow-hidden rounded-xl border border-border bg-card">
        <WireframeFlow
          screens={flow.screens}
          links={flow.links}
          selectedKey={selected}
          onSelect={(key) => {
            setSelected(key);
            onOpenScreen?.(key);
          }}
          onPersistPosition={(screenKey, x, y) => setPosition.mutate({ screenKey, x, y })}
          className="h-full w-full"
        />
      </div>

      {selectedScreen ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-2.5"
          data-testid="design-flow-selected"
        >
          <span className="text-sm font-semibold">{selectedScreen.screenName}</span>
          <span className="text-xs text-muted-foreground">
            {selectedScreen.approved
              ? t("flowDashboard.statusApproved", { defaultValue: "Approved" })
              : t("flowDashboard.statusInReview", { defaultValue: "In review" })}
          </span>
          {selectedScreen.previewUrl ? (
            <a
              href={toDisplayPreviewUrl(selectedScreen.previewUrl) ?? selectedScreen.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {t("flowDashboard.preview", { defaultValue: "Preview" })} <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </div>
      ) : null}

      {/* Board link editor (R3) */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold">
          {t("flowDashboard.screenNavLinksHeading", { defaultValue: "Screen navigation links" })}
        </h3>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!from.trim() || !to.trim()) return;
            addLink.mutate({ fromScreenKey: from.trim(), toScreenKey: to.trim(), label: label.trim() });
          }}
        >
          <ScreenKeyField label={t("flowDashboard.fromScreenLabel", { defaultValue: "From screen" })} value={from} onChange={setFrom} placeholder={t("flowDashboard.searchScreenPlaceholder", { defaultValue: "Search screens…" })} screens={flow.screens} />
          <ArrowRight className="mb-2 h-4 w-4 shrink-0 text-muted-foreground" />
          <ScreenKeyField label={t("flowDashboard.toScreenLabel", { defaultValue: "To screen" })} value={to} onChange={setTo} placeholder={t("flowDashboard.searchScreenPlaceholder", { defaultValue: "Search screens…" })} screens={flow.screens} />
          <LinkField label={t("flowDashboard.labelOptional", { defaultValue: "Label (optional)" })} value={label} onChange={setLabel} placeholder={t("flowDashboard.labelExamplePlaceholder", { defaultValue: "Login button" })} />
          <button
            type="submit"
            disabled={addLink.isPending || !from.trim() || !to.trim()}
            data-testid="design-flow-add-link"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> {t("flowDashboard.addLink", { defaultValue: "Add" })}
          </button>
        </form>

        {flow.links.length > 0 ? (
          <ul className="mt-3 divide-y divide-border/60">
            {flow.links.map((l) => (
              <li key={l.id} className="flex items-center gap-2 py-1.5 text-sm" data-testid="design-flow-link-row">
                <span className="font-medium">{l.fromScreenKey}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{l.toScreenKey}</span>
                {l.label ? <span className="text-xs text-muted-foreground">· {l.label}</span> : null}
                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                  {l.createdByKind}
                </span>
                <button
                  type="button"
                  onClick={() => removeLink.mutate(l.id)}
                  disabled={removeLink.isPending}
                  data-testid="design-flow-remove-link"
                  className="rounded-md border border-border p-1 text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                  aria-label={t("flowDashboard.deleteLink", { defaultValue: "Delete link" })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("flowDashboard.noLinks", {
              defaultValue: "No links yet. Enter screen keys to map out the navigation flow.",
            })}
          </p>
        )}
      </div>
    </div>
  );
}

function LinkField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-32 rounded-md border border-border bg-background px-2 py-1 text-sm",
          "focus:border-primary focus:outline-none",
        )}
      />
    </label>
  );
}

// Screen-key input with an autocomplete dropdown: type to filter the app's
// screens by name OR key, and pick from a live preview list below — so adding a
// 출발→도착 link doesn't mean remembering exact slugs.
function ScreenKeyField({
  label,
  value,
  onChange,
  placeholder,
  screens,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  screens: { screenKey: string; screenName: string }[];
}) {
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    return screens
      .filter((s) => !q || s.screenKey.toLowerCase().includes(q) || s.screenName.toLowerCase().includes(q))
      .slice(0, 8);
  }, [value, screens]);
  return (
    <label className="relative flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        className={cn(
          "w-36 rounded-md border border-border bg-background px-2 py-1 text-sm",
          "focus:border-primary focus:outline-none",
        )}
      />
      {open && matches.length > 0 ? (
        <ul className="absolute left-0 top-full z-30 mt-1 max-h-56 w-60 overflow-auto rounded-md border border-border bg-popover py-1 shadow-md">
          {matches.map((s) => (
            <li key={s.screenKey}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(s.screenKey);
                  setOpen(false);
                }}
                className="flex w-full flex-col items-start px-2 py-1 text-left hover:bg-accent"
              >
                <span className="max-w-full truncate text-sm font-medium">{s.screenName}</span>
                <span className="max-w-full truncate text-[11px] text-muted-foreground">{s.screenKey}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </label>
  );
}
