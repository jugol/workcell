import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { capabilities, capabilityAssignments } from "@workcell/db";
import type {
  CapabilityAssignmentStatus,
  CapabilityTrustTier,
  CapabilityVisibility,
} from "@workcell/shared";

// WC-27 (PLAN §9 #7 first slice): minimal Capability Registry service.
//
// Only the operations needed to wire up future visibility + update +
// approval slices: register a capability, assign it to a scope, list by
// scope, transition status/visibility. The actual capability *execution*
// (calling the underlying MCP/plugin/skill) lives elsewhere — this service
// is purely the registry.
export function capabilityService(db: Db) {
  return {
    // Register a capability or fetch the existing row for the same
    // (company, key, version). Idempotent on retries.
    register: async (input: {
      companyId: string;
      key: string;
      name: string;
      description?: string | null;
      sourceKind: string;
      sourceLocator?: string | null;
      version?: string;
      trustTier?: CapabilityTrustTier;
      metadata?: Record<string, unknown>;
    }) => {
      const version = input.version ?? "1.0.0";
      const existing = await db
        .select()
        .from(capabilities)
        .where(
          and(
            eq(capabilities.companyId, input.companyId),
            eq(capabilities.key, input.key),
            eq(capabilities.version, version),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (existing) return existing;
      const [created] = await db
        .insert(capabilities)
        .values({
          companyId: input.companyId,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          sourceKind: input.sourceKind,
          sourceLocator: input.sourceLocator ?? null,
          version,
          trustTier: input.trustTier ?? "unreviewed",
          metadata: input.metadata ?? {},
        })
        .returning();
      return created;
    },

    listForCompany: (companyId: string) =>
      db.select().from(capabilities).where(eq(capabilities.companyId, companyId)),

    getById: async (companyId: string, id: string) => {
      const rows = await db
        .select()
        .from(capabilities)
        .where(and(eq(capabilities.companyId, companyId), eq(capabilities.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },

    // Assign a capability to a scope. agentId omitted/null = company-wide.
    // Default status reflects the trust tier: trusted → active, otherwise
    // → pending_approval.
    assign: async (input: {
      companyId: string;
      capabilityId: string;
      agentId?: string | null;
      status?: CapabilityAssignmentStatus;
      visibility?: CapabilityVisibility;
      grantedByUserId?: string | null;
      grantedByAgentId?: string | null;
      notes?: string | null;
    }) => {
      // Default status reflects the trust tier (caller can override).
      // WC-53/#13: scope the capability lookup by companyId too, so the
      // service is self-defending against a caller that didn't pre-validate
      // ownership (don't read another company's capability's trust tier).
      let defaultStatus: CapabilityAssignmentStatus = "active";
      if (!input.status) {
        const cap = await db
          .select({ trustTier: capabilities.trustTier })
          .from(capabilities)
          .where(
            and(
              eq(capabilities.companyId, input.companyId),
              eq(capabilities.id, input.capabilityId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]);
        if (cap?.trustTier && cap.trustTier !== "trusted") {
          defaultStatus = "pending_approval";
        }
      }
      const targetStatus = input.status ?? defaultStatus;

      // Look up any existing assignment for this exact scope.
      const scopeWhere = and(
        eq(capabilityAssignments.companyId, input.companyId),
        eq(capabilityAssignments.capabilityId, input.capabilityId),
        input.agentId == null
          ? isNull(capabilityAssignments.agentId)
          : eq(capabilityAssignments.agentId, input.agentId),
      );
      const existing = await db
        .select()
        .from(capabilityAssignments)
        .where(scopeWhere)
        .limit(1)
        .then((rows) => rows[0]);

      if (existing) {
        // WC-53: a previously REVOKED scope must be re-grantable through
        // assign(). Previously assign() returned the stale revoked row with
        // a 201, so the agent was never actually re-granted while the API
        // reported success (and the unique index blocks inserting a fresh
        // row). Now re-assigning a revoked scope reactivates it: reset to the
        // target status, clear revokedAt, refresh grant attribution.
        if (existing.status === "revoked") {
          const [reactivated] = await db
            .update(capabilityAssignments)
            .set({
              status: targetStatus,
              visibility: input.visibility ?? existing.visibility,
              grantedByUserId: input.grantedByUserId ?? null,
              grantedByAgentId: input.grantedByAgentId ?? null,
              notes: input.notes ?? null,
              revokedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(capabilityAssignments.id, existing.id))
            .returning();
          return reactivated;
        }
        // active / pending_approval → idempotent no-op, return as-is.
        return existing;
      }

      const [created] = await db
        .insert(capabilityAssignments)
        .values({
          companyId: input.companyId,
          capabilityId: input.capabilityId,
          agentId: input.agentId ?? null,
          status: targetStatus,
          visibility: input.visibility ?? "default",
          grantedByUserId: input.grantedByUserId ?? null,
          grantedByAgentId: input.grantedByAgentId ?? null,
          notes: input.notes ?? null,
        })
        // WC-129: assign() is a non-atomic check-then-insert; two concurrent
        // calls for the same scope can both find no `existing` and both insert,
        // and the capability_assignments unique index (NULLS NOT DISTINCT) would
        // then 500 the loser. onConflictDoNothing makes the loser a no-op; we
        // return the row the racing call created — matching how capability
        // uniqueness (WC-53), the KG upserts (WC-54) and recordTurn (WC-128)
        // already guard their unique inserts. (A single-process test serializes
        // and can't force the interleave, so the regression guard is the
        // idempotency test above, not a race test.)
        .onConflictDoNothing()
        .returning();
      if (created) return created;
      return await db
        .select()
        .from(capabilityAssignments)
        .where(scopeWhere)
        .limit(1)
        .then((rows) => rows[0]);
    },

    // List all assignments for a scope. agentId null = company-wide only;
    // pass an agentId to get all assignments visible to that agent
    // (company-wide + agent-specific).
    listAssignmentsForScope: async (input: {
      companyId: string;
      agentId?: string | null;
    }) => {
      const rows = await db
        .select()
        .from(capabilityAssignments)
        .where(eq(capabilityAssignments.companyId, input.companyId));
      if (input.agentId === undefined) return rows;
      if (input.agentId === null) {
        return rows.filter((row) => row.agentId === null);
      }
      const requested = input.agentId;
      return rows.filter((row) => row.agentId === null || row.agentId === requested);
    },

    // Transition status on an assignment. Auto-stamps revokedAt when going
    // to "revoked".
    transitionStatus: async (input: {
      companyId: string;
      id: string;
      status: CapabilityAssignmentStatus;
      notes?: string | null;
    }) => {
      const now = new Date();
      const [updated] = await db
        .update(capabilityAssignments)
        .set({
          status: input.status,
          notes: input.notes ?? undefined,
          revokedAt: input.status === "revoked" ? now : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(capabilityAssignments.companyId, input.companyId),
            eq(capabilityAssignments.id, input.id),
          ),
        )
        .returning();
      return updated ?? null;
    },

    // Update visibility separately so a UI can flip it without touching
    // status.
    setVisibility: async (input: {
      companyId: string;
      id: string;
      visibility: CapabilityVisibility;
    }) => {
      const [updated] = await db
        .update(capabilityAssignments)
        .set({ visibility: input.visibility, updatedAt: new Date() })
        .where(
          and(
            eq(capabilityAssignments.companyId, input.companyId),
            eq(capabilityAssignments.id, input.id),
          ),
        )
        .returning();
      return updated ?? null;
    },

    // WC-45 (§9 #7): visibility-aware effective capability listing for
    // an agent at execution time.
    //
    // Definition: a capability is "effective for agent X" when there's an
    // assignment with status="active" + visibility != "hidden" + scope
    // matches (company-wide OR agent-specific to X). Deprecated visibility
    // is included with a flag so callers can render a warning. Returns
    // the joined { capability, assignment } pairs ordered by name.
    //
    // This is what agent runtime code should call to decide which
    // capabilities to surface in the agent's effective tool/skill list —
    // NOT listAssignmentsForScope, which is the admin view that includes
    // pending/revoked.
    listEffectiveForAgent: async (input: {
      companyId: string;
      agentId: string;
    }) => {
      const rows = await db
        .select()
        .from(capabilityAssignments)
        .where(eq(capabilityAssignments.companyId, input.companyId));
      const eligibleAssignments = rows.filter(
        (row) =>
          row.status === "active" &&
          row.visibility !== "hidden" &&
          (row.agentId === null || row.agentId === input.agentId),
      );
      if (eligibleAssignments.length === 0) {
        return [];
      }
      const capabilityIds = Array.from(new Set(eligibleAssignments.map((row) => row.capabilityId)));
      const capRows = await db
        .select()
        .from(capabilities)
        .where(
          and(
            eq(capabilities.companyId, input.companyId),
            inArray(capabilities.id, capabilityIds),
          ),
        );
      const capById = new Map(capRows.map((c) => [c.id, c] as const));
      const result = eligibleAssignments
        .map((assignment) => {
          const capability = capById.get(assignment.capabilityId);
          if (!capability) return null;
          return { capability, assignment };
        })
        .filter((entry): entry is { capability: typeof capRows[number]; assignment: typeof rows[number] } => entry !== null)
        .sort((a, b) => a.capability.name.localeCompare(b.capability.name));
      return result;
    },

    // WC-36: explicit approval action for pending_approval assignments.
    // Refuses to "approve" anything that isn't currently pending — the
    // caller should observe the assignment's status first.
    approve: async (input: {
      companyId: string;
      id: string;
      approverUserId: string;
    }) => {
      const existing = await db
        .select()
        .from(capabilityAssignments)
        .where(
          and(
            eq(capabilityAssignments.companyId, input.companyId),
            eq(capabilityAssignments.id, input.id),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (!existing) return null;
      if (existing.status !== "pending_approval") {
        throw new Error(
          `cannot approve assignment with status="${existing.status}" (must be pending_approval)`,
        );
      }
      const [updated] = await db
        .update(capabilityAssignments)
        .set({
          status: "active",
          grantedByUserId: input.approverUserId,
          updatedAt: new Date(),
        })
        .where(eq(capabilityAssignments.id, input.id))
        .returning();
      return updated;
    },
  };
}
