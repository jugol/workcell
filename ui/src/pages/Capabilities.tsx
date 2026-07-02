import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CapabilityAssignmentStatus,
  CapabilityVisibility,
} from "@workcell/shared";
import { Boxes } from "lucide-react";
import { capabilitiesApi } from "../api/capabilities";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { useTranslation } from "@/i18n";

// WC-35 (PLAN §9 #7 UI): Capability Registry surface. First-slice scope:
// list capabilities + assignments, show their status/visibility, and let
// the user transition an assignment's status (active / pending_approval /
// revoked) and visibility (default / hidden / deprecated). Registration
// + assignment creation are also exposed via inline forms.
//
// The page exists primarily so administrators see the registry at all —
// future slices will replace the bare tables with richer cards once the
// approval workflow is wired.

const TRUST_TIER_LABELS: Record<string, string> = {
  trusted: "Trusted",
  reviewed: "Reviewed",
  unreviewed: "Unreviewed",
};

const STATUS_OPTIONS: CapabilityAssignmentStatus[] = [
  "active",
  "pending_approval",
  "revoked",
];

const VISIBILITY_OPTIONS: CapabilityVisibility[] = [
  "default",
  "hidden",
  "deprecated",
];

export function Capabilities() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("capabilities.breadcrumb", { defaultValue: "Capabilities" }) }]);
  }, [setBreadcrumbs, t]);

  const capabilitiesQuery = useQuery({
    queryKey: ["capabilities", "list", selectedCompanyId],
    queryFn: () => capabilitiesApi.listForCompany(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const assignmentsQuery = useQuery({
    queryKey: ["capability-assignments", "list", selectedCompanyId],
    queryFn: () => capabilitiesApi.listAssignments(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const transitionStatus = useMutation({
    mutationFn: ({
      assignmentId,
      status,
    }: {
      assignmentId: string;
      status: CapabilityAssignmentStatus;
    }) => capabilitiesApi.patchAssignment(assignmentId, { status }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({
        queryKey: ["capability-assignments", "list", selectedCompanyId],
      });
    },
    onError: (err) =>
      setErrorMessage(err instanceof Error ? err.message : String(err)),
  });

  // WC-36: explicit approval action for pending_approval assignments.
  const approveAssignment = useMutation({
    mutationFn: (assignmentId: string) =>
      capabilitiesApi.approveAssignment(assignmentId),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({
        queryKey: ["capability-assignments", "list", selectedCompanyId],
      });
    },
    onError: (err) =>
      setErrorMessage(err instanceof Error ? err.message : String(err)),
  });

  const setVisibility = useMutation({
    mutationFn: ({
      assignmentId,
      visibility,
    }: {
      assignmentId: string;
      visibility: CapabilityVisibility;
    }) => capabilitiesApi.patchAssignment(assignmentId, { visibility }),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({
        queryKey: ["capability-assignments", "list", selectedCompanyId],
      });
    },
    onError: (err) =>
      setErrorMessage(err instanceof Error ? err.message : String(err)),
  });

  const capabilities = capabilitiesQuery.data?.items ?? [];
  const assignments = assignmentsQuery.data?.items ?? [];

  const capabilitiesById = useMemo(() => {
    const map = new Map<string, (typeof capabilities)[number]>();
    for (const cap of capabilities) map.set(cap.id, cap);
    return map;
  }, [capabilities]);

  if (capabilitiesQuery.isLoading || assignmentsQuery.isLoading) {
    return <PageSkeleton />;
  }

  const loadError = capabilitiesQuery.error ?? assignmentsQuery.error;

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center gap-3">
        <Boxes className="h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-xl font-semibold">
            {t("capabilities.title", { defaultValue: "Capabilities" })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("capabilities.description", {
              defaultValue:
                "Registry of capabilities the team has installed and how they're assigned to agents. Approval workflow lands in a later slice; this page lets admins view and transition existing assignments.",
            })}
          </p>
        </div>
      </header>

      {errorMessage && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </p>
      )}

      {loadError && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t("capabilities.loadError", {
            defaultValue: "Failed to load capabilities. Try again.",
          })}
        </p>
      )}

      <section aria-labelledby="capabilities-heading" className="space-y-2">
        <h2 id="capabilities-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("capabilities.manifestHeading", {
            defaultValue: "Manifest ({{count}})",
            count: capabilities.length,
          })}
        </h2>
        {capabilities.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
            {t("capabilities.manifestEmpty", {
              defaultValue:
                "No capabilities registered for this team yet. Future slices add a Register form here.",
            })}
          </p>
        ) : (
          <ul className="space-y-2">
            {capabilities.map((cap) => (
              <li
                key={cap.id}
                className="rounded-md border border-border p-3"
                data-testid="capability-row"
              >
                <div className="flex items-center gap-2">
                  <code className="font-mono text-xs">{cap.key}</code>
                  <span className="text-xs text-muted-foreground">@{cap.version}</span>
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                    {TRUST_TIER_LABELS[cap.trustTier] ?? cap.trustTier}
                  </span>
                </div>
                <div className="mt-1 text-sm">{cap.name}</div>
                {cap.description && (
                  <p className="mt-1 text-xs text-muted-foreground">{cap.description}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="assignments-heading" className="space-y-2">
        <h2 id="assignments-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("capabilities.assignmentsHeading", {
            defaultValue: "Assignments ({{count}})",
            count: assignments.length,
          })}
        </h2>
        {assignments.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
            {t("capabilities.assignmentsEmpty", {
              defaultValue:
                "No active assignments. Once capabilities are assigned to a scope (team-wide or per-agent), they show up here.",
            })}
          </p>
        ) : (
          <ul className="space-y-2">
            {assignments.map((a) => {
              const cap = capabilitiesById.get(a.capabilityId);
              return (
                <li
                  key={a.id}
                  className="rounded-md border border-border p-3"
                  data-testid="assignment-row"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <code className="font-mono text-xs">{cap?.key ?? a.capabilityId}</code>
                    <span className="text-xs text-muted-foreground">
                      {t("capabilities.scopeLabel", { defaultValue: "Scope:" })}{" "}
                      {a.agentId
                        ? `agent ${a.agentId.slice(0, 8)}…`
                        : t("capabilities.scopeCompanyWide", { defaultValue: "team-wide" })}
                    </span>
                    <span className="ml-auto text-xs">
                      {a.status} · {a.visibility}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {a.status === "pending_approval" ? (
                      <button
                        type="button"
                        className="rounded-md border border-emerald-500/45 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-500/20 dark:text-emerald-300"
                        onClick={() => approveAssignment.mutate(a.id)}
                        disabled={approveAssignment.isPending}
                      >
                        {approveAssignment.isPending && approveAssignment.variables === a.id
                          ? t("capabilities.approving", { defaultValue: "Approving…" })
                          : t("capabilities.approve", { defaultValue: "Approve" })}
                      </button>
                    ) : null}
                    <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("capabilities.statusLabel", { defaultValue: "Status" })}
                    </label>
                    <select
                      value={a.status}
                      onChange={(e) =>
                        transitionStatus.mutate({
                          assignmentId: a.id,
                          status: e.target.value as CapabilityAssignmentStatus,
                        })
                      }
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("capabilities.visibilityLabel", { defaultValue: "Visibility" })}
                    </label>
                    <select
                      value={a.visibility}
                      onChange={(e) =>
                        setVisibility.mutate({
                          assignmentId: a.id,
                          visibility: e.target.value as CapabilityVisibility,
                        })
                      }
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                    >
                      {VISIBILITY_OPTIONS.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
