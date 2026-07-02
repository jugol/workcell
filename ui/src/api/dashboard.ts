import type { DashboardSummary, SettlementReport } from "@workcell/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  settlement: (companyId: string, params: { start: string; end: string; label: string }) =>
    api.get<SettlementReport>(
      `/companies/${companyId}/dashboard/settlement?start=${encodeURIComponent(params.start)}&end=${encodeURIComponent(params.end)}&label=${encodeURIComponent(params.label)}`,
    ),
};
