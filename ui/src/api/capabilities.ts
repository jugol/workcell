import type {
  Capability,
  CapabilityAssignment,
  CapabilityAssignmentStatus,
  CapabilityTrustTier,
  CapabilityVisibility,
} from "@workcell/shared";
import { api } from "./client";

// WC-35 (PLAN §9 #7 UI): typed client for the WC-30 capability registry
// REST surface. Methods mirror the routes 1:1.
export const capabilitiesApi = {
  listForCompany: (companyId: string) =>
    api.get<{ items: Capability[] }>(`/companies/${companyId}/capabilities`),

  register: (
    companyId: string,
    data: {
      key: string;
      name: string;
      description?: string | null;
      sourceKind: string;
      sourceLocator?: string | null;
      version?: string;
      trustTier?: CapabilityTrustTier;
      metadata?: Record<string, unknown>;
    },
  ) =>
    api.post<{ capability: Capability }>(
      `/companies/${companyId}/capabilities`,
      data,
    ),

  assign: (
    companyId: string,
    capabilityId: string,
    data: {
      agentId?: string | null;
      status?: CapabilityAssignmentStatus;
      visibility?: CapabilityVisibility;
      notes?: string | null;
    } = {},
  ) =>
    api.post<{ assignment: CapabilityAssignment }>(
      `/companies/${companyId}/capabilities/${capabilityId}/assign`,
      data,
    ),

  listAssignments: (companyId: string, agentId?: string | null) => {
    const qs =
      agentId === undefined
        ? ""
        : `?agentId=${agentId === null ? "null" : encodeURIComponent(agentId)}`;
    return api.get<{ items: CapabilityAssignment[] }>(
      `/companies/${companyId}/capability-assignments${qs}`,
    );
  },

  patchAssignment: (
    assignmentId: string,
    data: {
      status?: CapabilityAssignmentStatus;
      visibility?: CapabilityVisibility;
      notes?: string | null;
    },
  ) =>
    api.patch<{ assignment: CapabilityAssignment }>(
      `/capability-assignments/${assignmentId}`,
      data,
    ),

  // WC-36: explicit approval action — board-only on the server side.
  // Transitions pending_approval → active and stamps grantedByUserId.
  approveAssignment: (assignmentId: string) =>
    api.post<{ assignment: CapabilityAssignment }>(
      `/capability-assignments/${assignmentId}/approve`,
      {},
    ),
};
