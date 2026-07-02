import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, DollarSign, Loader2, Receipt, TrendingUp } from "lucide-react";
import { dashboardApi } from "../api/dashboard";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "./MetricCard";
import { EmptyState } from "./EmptyState";
import { cn } from "../lib/utils";
import { useTranslation } from "@/i18n";

type PeriodKey = "thisMonth" | "lastMonth" | "last7Days";

interface PeriodRange {
  start: string;
  end: string;
  label: string;
}

/**
 * Compute the ISO start/end range for a settlement period. UTC-based: callers
 * only need a stable window, and using UTC avoids off-by-one issues around
 * local midnight / DST. `end` is exclusive (start of the next instant).
 */
function computePeriodRange(period: PeriodKey, now: Date): PeriodRange {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  if (period === "thisMonth") {
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 1));
    return { start: start.toISOString(), end: end.toISOString(), label: "This Month" };
  }

  if (period === "lastMonth") {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    return { start: start.toISOString(), end: end.toISOString(), label: "Last Month" };
  }

  // last7Days: from the start of the day 6 days ago through now.
  const endOfToday = new Date(Date.UTC(year, month, now.getUTCDate() + 1));
  const startOf7 = new Date(Date.UTC(year, month, now.getUTCDate() - 6));
  return { start: startOf7.toISOString(), end: endOfToday.toISOString(), label: "Last 7 Days" };
}

/** Average cycle hours → "—" / "Xh" / "Xd" (rounded). */
function formatCycleHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "—";
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Cents → "$X.XX". */
function formatCost(cents: number): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  return `$${(safe / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** runsSucceeded / runsTotal → "X%" / "—". */
function formatSuccessRate(succeeded: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "—";
  return `${Math.round((succeeded / total) * 100)}%`;
}

interface SettlementPanelProps {
  companyId: string;
}

export function SettlementPanel({ companyId }: SettlementPanelProps) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<PeriodKey>("thisMonth");

  const range = useMemo(() => computePeriodRange(period, new Date()), [period]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboardSettlement(companyId, range.start, range.end),
    queryFn: () => dashboardApi.settlement(companyId, range),
    enabled: !!companyId,
  });

  const periodOptions: { key: PeriodKey; label: string }[] = [
    { key: "thisMonth", label: t("dashboard.settlement.period.thisMonth", { defaultValue: "This Month" }) },
    { key: "lastMonth", label: t("dashboard.settlement.period.lastMonth", { defaultValue: "Last Month" }) },
    { key: "last7Days", label: t("dashboard.settlement.period.last7Days", { defaultValue: "Last 7 Days" }) },
  ];

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-[3px]">
        {periodOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setPeriod(option.key)}
            className={cn(
              "rounded-sm px-3 py-1 text-sm font-medium transition-colors",
              period === option.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : data ? (
        <>
          {/* Totals */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
            <MetricCard
              icon={CheckCircle2}
              value={data.totals.completedIssues}
              label={t("dashboard.settlement.totals.completedIssues", { defaultValue: "Completed Issues" })}
            />
            <MetricCard
              icon={Clock}
              value={formatCycleHours(data.totals.avgCycleHours)}
              label={t("dashboard.settlement.totals.avgCycle", { defaultValue: "Avg Cycle Time" })}
            />
            <MetricCard
              icon={DollarSign}
              value={formatCost(data.totals.totalCostCents)}
              label={t("dashboard.settlement.totals.totalCost", { defaultValue: "Total Cost" })}
            />
            <MetricCard
              icon={TrendingUp}
              value={formatSuccessRate(data.totals.runsSucceeded, data.totals.runsTotal)}
              label={t("dashboard.settlement.totals.successRate", { defaultValue: "Run Success Rate" })}
              description={
                <span>
                  {t("dashboard.settlement.totals.runsDesc", {
                    defaultValue: "{{succeeded}} of {{total}} runs",
                    succeeded: data.totals.runsSucceeded,
                    total: data.totals.runsTotal,
                  })}
                </span>
              }
            />
          </div>

          {/* Per-agent breakdown */}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t("dashboard.settlement.byAgent.title", { defaultValue: "By Agent" })}
            </h3>
            {data.byAgent.length === 0 ? (
              <EmptyState
                icon={Receipt}
                message={t("dashboard.settlement.byAgent.empty", {
                  defaultValue: "No work was completed in this period.",
                })}
              />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-accent/20 text-xs text-muted-foreground">
                      <th className="px-4 py-2 text-left font-medium">
                        {t("dashboard.settlement.byAgent.col.agent", { defaultValue: "Agent" })}
                      </th>
                      <th className="px-4 py-2 text-right font-medium">
                        {t("dashboard.settlement.byAgent.col.completed", { defaultValue: "Completed" })}
                      </th>
                      <th className="px-4 py-2 text-right font-medium">
                        {t("dashboard.settlement.byAgent.col.avgCycle", { defaultValue: "Avg Cycle" })}
                      </th>
                      <th className="px-4 py-2 text-right font-medium">
                        {t("dashboard.settlement.byAgent.col.cost", { defaultValue: "Cost" })}
                      </th>
                      <th className="px-4 py-2 text-right font-medium">
                        {t("dashboard.settlement.byAgent.col.successRate", { defaultValue: "Success Rate" })}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.byAgent.map((row) => (
                      <tr key={row.agentId} className="transition-colors hover:bg-accent/30">
                        <td className="px-4 py-2.5 font-medium">{row.agentName}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{row.completedIssues}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{formatCycleHours(row.avgCycleHours)}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatCost(row.costCents)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {formatSuccessRate(row.runsSucceeded, row.runsTotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
