import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues } from "@workcell/db";
import type { SettlementReport, SettlementAgentRow } from "@workcell/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = getUtcMonthStart(now);
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const runActivityDayExpr = sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const runActivityRows = await db
        .select({
          date: runActivityDayExpr,
          status: heartbeatRuns.status,
          count: sql<number>`count(*)::double precision`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, runActivityStart),
          ),
        )
        .groupBy(runActivityDayExpr, heartbeatRuns.status);

      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          { date, succeeded: 0, failed: 0, other: 0, total: 0 },
        ]),
      );
      for (const row of runActivityRows) {
        const bucket = runActivity.get(row.date);
        if (!bucket) continue;
        const count = Number(row.count);
        if (row.status === "succeeded") bucket.succeeded += count;
        else if (row.status === "failed" || row.status === "timed_out") bucket.failed += count;
        else bucket.other += count;
        bucket.total += count;
      }

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
      };
    },
    settlement: async (
      companyId: string,
      opts: { startIso: string; endIso: string; label: string },
    ): Promise<SettlementReport> => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const start = new Date(opts.startIso);
      const end = new Date(opts.endIso);

      const UNASSIGNED = "__unassigned__";

      // Completed issues per agent + per-agent average cycle time.
      const issueRows = await db
        .select({
          agentId: issues.assigneeAgentId,
          completedIssues: sql<number>`count(*)::int`,
          avgCycleSec: sql<
            number | null
          >`avg(extract(epoch from (${issues.completedAt} - ${issues.createdAt})))`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            gte(issues.completedAt, start),
            lt(issues.completedAt, end),
          ),
        )
        .groupBy(issues.assigneeAgentId);

      // Overall average cycle time (totals).
      const [{ overallAvgCycleSec }] = await db
        .select({
          overallAvgCycleSec: sql<
            number | null
          >`avg(extract(epoch from (${issues.completedAt} - ${issues.createdAt})))`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "done"),
            gte(issues.completedAt, start),
            lt(issues.completedAt, end),
          ),
        );

      // Cost per agent.
      const costRows = await db
        .select({
          agentId: costEvents.agentId,
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, start),
            lt(costEvents.occurredAt, end),
          ),
        )
        .groupBy(costEvents.agentId);

      // Runs per agent (total + succeeded).
      const runRows = await db
        .select({
          agentId: heartbeatRuns.agentId,
          runsTotal: sql<number>`count(*)::int`,
          runsSucceeded: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded')::int`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, start),
            lt(heartbeatRuns.createdAt, end),
          ),
        )
        .groupBy(heartbeatRuns.agentId);

      // Agent name lookup.
      const agentRows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const agentNames = new Map<string, string>(
        agentRows.map((row) => [row.id, row.name]),
      );

      const normalizeId = (id: string | null): string => id ?? UNASSIGNED;

      // Merge all sources keyed by agentId.
      const rows = new Map<
        string,
        {
          agentId: string;
          completedIssues: number;
          avgCycleSec: number | null;
          costCents: number;
          runsTotal: number;
          runsSucceeded: number;
        }
      >();
      const ensureRow = (agentId: string) => {
        let row = rows.get(agentId);
        if (!row) {
          row = {
            agentId,
            completedIssues: 0,
            avgCycleSec: null,
            costCents: 0,
            runsTotal: 0,
            runsSucceeded: 0,
          };
          rows.set(agentId, row);
        }
        return row;
      };

      for (const row of issueRows) {
        const target = ensureRow(normalizeId(row.agentId));
        target.completedIssues = Number(row.completedIssues);
        target.avgCycleSec = row.avgCycleSec != null ? Number(row.avgCycleSec) : null;
      }
      for (const row of costRows) {
        const target = ensureRow(normalizeId(row.agentId));
        target.costCents = Number(row.costCents);
      }
      for (const row of runRows) {
        const target = ensureRow(normalizeId(row.agentId));
        target.runsTotal = Number(row.runsTotal);
        target.runsSucceeded = Number(row.runsSucceeded);
      }

      const byAgent: SettlementAgentRow[] = Array.from(rows.values())
        .map((row) => ({
          agentId: row.agentId,
          agentName:
            row.agentId === UNASSIGNED
              ? "(unassigned)"
              : agentNames.get(row.agentId) ?? "(unknown)",
          completedIssues: row.completedIssues,
          avgCycleHours: row.avgCycleSec != null ? row.avgCycleSec / 3600 : null,
          costCents: row.costCents,
          runsTotal: row.runsTotal,
          runsSucceeded: row.runsSucceeded,
        }))
        .sort((a, b) => b.completedIssues - a.completedIssues);

      const totals = byAgent.reduce(
        (acc, row) => {
          acc.completedIssues += row.completedIssues;
          acc.totalCostCents += row.costCents;
          acc.runsTotal += row.runsTotal;
          acc.runsSucceeded += row.runsSucceeded;
          return acc;
        },
        {
          completedIssues: 0,
          totalCostCents: 0,
          runsTotal: 0,
          runsSucceeded: 0,
        },
      );

      return {
        companyId,
        period: { startIso: opts.startIso, endIso: opts.endIso, label: opts.label },
        totals: {
          completedIssues: totals.completedIssues,
          avgCycleHours:
            overallAvgCycleSec != null ? Number(overallAvgCycleSec) / 3600 : null,
          totalCostCents: totals.totalCostCents,
          runsTotal: totals.runsTotal,
          runsSucceeded: totals.runsSucceeded,
        },
        byAgent,
      };
    },
  };
}
