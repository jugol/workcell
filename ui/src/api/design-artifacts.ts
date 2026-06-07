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
  issueId: string | null;
  type: string;
  provider: string | null;
  title: string;
  status: string;
  reviewState: string;
  isPrimary: boolean;
  externalId: string | null;
  previewUrl: string | null;
  body: string | null;
  createdAt: string;
  updatedAt: string;
}

export const designArtifactsApi = {
  listForCompany: (companyId: string) =>
    api.get<{ items: DesignArtifact[] }>(
      `/companies/${companyId}/design-artifacts`,
    ),

  // WC-194: hard-delete a design (board-only, irreversible). Superseded versions
  // are auto-deleted server-side on approval; this is the manual control.
  remove: (workProductId: string) =>
    api.post<{ ok: boolean; deletedId: string }>(
      `/work-products/${workProductId}/delete`,
      {},
    ),
};
