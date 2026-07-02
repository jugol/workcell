export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
}

export interface SettlementAgentRow {
  agentId: string;
  agentName: string;
  completedIssues: number;
  avgCycleHours: number | null;
  costCents: number;
  runsTotal: number;
  runsSucceeded: number;
}

export interface SettlementReport {
  companyId: string;
  period: { startIso: string; endIso: string; label: string };
  totals: {
    completedIssues: number;
    avgCycleHours: number | null;
    totalCostCents: number;
    runsTotal: number;
    runsSucceeded: number;
  };
  byAgent: SettlementAgentRow[];
}
