import type {
  Company,
  CompanyPortabilityExportRequest,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityImportRequest,
  CompanyPortabilityImportResult,
  CompanyPortabilityPreviewRequest,
  CompanyPortabilityPreviewResult,
  UpdateCompanyBranding,
} from "@workcell/shared";
import { api } from "./client";

export type CompanyStats = Record<string, { agentCount: number; issueCount: number }>;

/**
 * Team autonomy flags saved through the regular company PATCH.
 *
 * The server contract is confirmed (booleans on Company), but the
 * @workcell/shared Company type may not carry these fields yet while the
 * server work lands in parallel. Declaring them locally keeps the UI
 * type-safe either way: once shared ships the fields, the intersection
 * below stays compatible.
 */
export interface CompanyAutonomySettings {
  /** Default false — system immediately accepts agent confirmation requests. */
  autoApproveConfirmations?: boolean;
  /** Default true — Orchestrator picks up newly created issues automatically. */
  autoRouteNewIssues?: boolean;
  /** Default true — new pairs start with auto-run rounds enabled. */
  pairAutoRunDefault?: boolean;
}

export const companiesApi = {
  list: () => api.get<Company[]>("/companies"),
  get: (companyId: string) => api.get<Company>(`/companies/${companyId}`),
  stats: () => api.get<CompanyStats>("/companies/stats"),
  create: (data: {
    name: string;
    description?: string | null;
    budgetMonthlyCents?: number;
    planReportLanguage?: string;
    requireDesignFirst?: boolean;
  }) =>
    api.post<Company>("/companies", data),
  update: (
    companyId: string,
    data: Partial<
      Pick<
        Company,
        | "name"
        | "description"
        | "status"
        | "budgetMonthlyCents"
        | "attachmentMaxBytes"
        | "requireBoardApprovalForNewAgents"
        | "requireDesignFirst"
        | "feedbackDataSharingEnabled"
        | "brandColor"
        | "planReportLanguage"
        | "logoAssetId"
      >
    > &
      CompanyAutonomySettings,
  ) => api.patch<Company>(`/companies/${companyId}`, data),
  updateBranding: (companyId: string, data: UpdateCompanyBranding) =>
    api.patch<Company>(`/companies/${companyId}/branding`, data),
  archive: (companyId: string) => api.post<Company>(`/companies/${companyId}/archive`, {}),
  remove: (companyId: string) => api.delete<{ ok: true }>(`/companies/${companyId}`),
  exportBundle: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportResult>(`/companies/${companyId}/exports`, data),
  exportPreview: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportPreviewResult>(`/companies/${companyId}/exports/preview`, data),
  importPreview: (data: CompanyPortabilityPreviewRequest) =>
    api.post<CompanyPortabilityPreviewResult>("/companies/import/preview", data),
  importBundle: (data: CompanyPortabilityImportRequest) =>
    api.post<CompanyPortabilityImportResult>("/companies/import", data),
};
