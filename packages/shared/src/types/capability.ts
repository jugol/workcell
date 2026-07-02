// WC-27 (PLAN §9 #7 first slice): Capability Registry types.

// Aligned with D15 trust tiers: trusted = signed/vetted, reviewed = audited
// but not formally trusted, unreviewed = default for new captures.
export type CapabilityTrustTier = "trusted" | "reviewed" | "unreviewed";

// Source kinds — open-ended string so connector kinds can grow without
// type churn; common values: "plugin", "mcp", "skill_bundle", "builtin".
export type CapabilitySourceKind = string;

export interface Capability {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  sourceKind: CapabilitySourceKind;
  sourceLocator: string | null;
  version: string;
  trustTier: CapabilityTrustTier;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type CapabilityAssignmentStatus = "active" | "pending_approval" | "revoked";
export type CapabilityVisibility = "default" | "hidden" | "deprecated";

export interface CapabilityAssignment {
  id: string;
  companyId: string;
  capabilityId: string;
  // null = company-wide assignment.
  agentId: string | null;
  status: CapabilityAssignmentStatus;
  visibility: CapabilityVisibility;
  grantedByUserId: string | null;
  grantedByAgentId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}
