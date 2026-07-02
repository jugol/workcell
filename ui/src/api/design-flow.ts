import { api } from "./client";
import type { DesignFlow, DesignGuide, DesignScreenLink, DesignScreenPlan } from "@workcell/shared";

// Design-system redesign — typed clients for the wireframe flow dashboard (R4),
// cross-screen nav links (R3), and the design guide page (R1). The company-scope
// variants operate on the "default app" (project-less 시안); the project-scope
// variants on a single project.
export const designFlowApi = {
  getForCompany: (companyId: string) =>
    api.get<DesignFlow>(`/companies/${companyId}/design-flow`),
  getForProject: (projectId: string) =>
    api.get<DesignFlow>(`/projects/${projectId}/design-flow`),

  addLinkForCompany: (
    companyId: string,
    body: { fromScreenKey: string; toScreenKey: string; label?: string },
  ) => api.post<DesignScreenLink>(`/companies/${companyId}/design-screen-links`, body),
  addLinkForProject: (
    projectId: string,
    body: { fromScreenKey: string; toScreenKey: string; label?: string },
  ) => api.post<DesignScreenLink>(`/projects/${projectId}/design-screen-links`, body),

  removeLink: (companyId: string, id: string) =>
    api.delete<{ ok: boolean; deletedId: string }>(
      `/companies/${companyId}/design-screen-links/${id}`,
    ),

  // R5: persist a screen node's canvas position (called on drag-end). screenKey
  // is the flow node's own key; encode it for the URL path.
  setPositionForCompany: (
    companyId: string,
    screenKey: string,
    body: { x: number; y: number },
  ) =>
    api.put<{ screenKey: string; x: number; y: number }>(
      `/companies/${companyId}/design-screen-positions/${encodeURIComponent(screenKey)}`,
      body,
    ),
  setPositionForProject: (
    projectId: string,
    screenKey: string,
    body: { x: number; y: number },
  ) =>
    api.put<{ screenKey: string; x: number; y: number }>(
      `/projects/${projectId}/design-screen-positions/${encodeURIComponent(screenKey)}`,
      body,
    ),

  // R4: read a screen's paired "화면 기획" (screen plan). null = no plan authored
  // yet (the detail page shows an empty/"re-run the designer" state).
  getScreenPlanForCompany: (companyId: string, screenKey: string) =>
    api.get<DesignScreenPlan | null>(
      `/companies/${companyId}/screens/${encodeURIComponent(screenKey)}/plan`,
    ),
  getScreenPlanForProject: (projectId: string, screenKey: string) =>
    api.get<DesignScreenPlan | null>(
      `/projects/${projectId}/screens/${encodeURIComponent(screenKey)}/plan`,
    ),
};

export const designGuideApi = {
  getForCompany: (companyId: string) =>
    api.get<DesignGuide>(`/companies/${companyId}/design-guide`),
  getForProject: (projectId: string) =>
    api.get<DesignGuide>(`/projects/${projectId}/design-guide`),

  updateForCompany: (companyId: string, notesMarkdown: string) =>
    api.put<{ notesMarkdown: string; updatedAt: string | null }>(
      `/companies/${companyId}/design-guide`,
      { notesMarkdown },
    ),
  updateForProject: (projectId: string, notesMarkdown: string) =>
    api.put<{ notesMarkdown: string; updatedAt: string | null }>(
      `/projects/${projectId}/design-guide`,
      { notesMarkdown },
    ),
};
