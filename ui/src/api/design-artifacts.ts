import { api } from "./client";

// WC-191/192/194 (design system source-of-truth window): typed client for the
// WC-40 Open Design artifact listing + the WC-194 hard-delete control. The
// route returns design-type work products (mockup / design / ui_preview /
// screenshot / figma_frame) with the preview URL + summary aliased to
// previewUrl/body, plus reviewState/isPrimary. Superseded versions are
// hard-deleted server-side on approval, so the listing is always the live set.
export interface DesignArtifact {
  id: string;
  companyId: string;
  // screen_key is project-scoped (company fallback when null) — the inbox scopes
  // its approved-elsewhere suppression by projectId + screenKey.
  projectId: string | null;
  issueId: string | null;
  type: string;
  provider: string | null;
  title: string;
  status: string;
  reviewState: string;
  isPrimary: boolean;
  // Design-system redesign: screen identity (one artifact = one screen). Null on
  // legacy rows — the UI falls back to title-lineage grouping (effectiveScreenKey).
  screenKey: string | null;
  screenName: string | null;
  externalId: string | null;
  previewUrl: string | null;
  body: string | null;
  // The linked issue's status (null for project-level artifacts). The inbox uses
  // it to hide design reviews for terminal issues (done/cancelled).
  issueStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export const designArtifactsApi = {
  listForCompany: (companyId: string) =>
    api.get<{ items: DesignArtifact[] }>(
      `/companies/${companyId}/design-artifacts`,
    ),

  // Project-scoped listing — the project's own design source of truth
  // (ProjectDetail "Design System" tab). Optional types override mirrors
  // the server's ?types=... open-enum filter.
  listForProject: (projectId: string, types?: string[]) =>
    api.get<{ items: DesignArtifact[] }>(
      `/projects/${projectId}/design-artifacts${
        types && types.length > 0
          ? `?types=${encodeURIComponent(types.join(","))}`
          : ""
      }`,
    ),

  // WC-194: hard-delete a design (board-only, irreversible). Superseded versions
  // are auto-deleted server-side on approval; this is the manual control.
  remove: (workProductId: string) =>
    api.post<{ ok: boolean; deletedId: string }>(
      `/work-products/${workProductId}/delete`,
      {},
    ),
};
