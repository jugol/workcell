import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, capabilityAssignments, companies, createDb } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { capabilityService } from "../services/capabilities.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-27 capability registry embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-27 Capability Registry (PLAN §9 #7 first slice)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof capabilityService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc27-capabilities-");
    db = createDb(tempDb.connectionString);
    svc = capabilityService(db);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapter: "claude_local",
    });
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, capabilities, capability_assignments restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("register() inserts a capability and is idempotent on (company, key, version)", async () => {
    const a = await svc.register({
      companyId,
      key: "anthropic/claude-mcp",
      name: "Claude MCP",
      sourceKind: "mcp",
    });
    expect(a.id).toBeTruthy();
    expect(a.version).toBe("1.0.0");
    expect(a.trustTier).toBe("unreviewed");

    // Second register with same key+version returns the same row.
    const b = await svc.register({
      companyId,
      key: "anthropic/claude-mcp",
      name: "Claude MCP (rename attempt)",
      sourceKind: "mcp",
    });
    expect(b.id).toBe(a.id);
  });

  it("register() with a different version creates a new row", async () => {
    const v1 = await svc.register({
      companyId,
      key: "anthropic/claude-mcp",
      name: "Claude MCP",
      sourceKind: "mcp",
    });
    const v2 = await svc.register({
      companyId,
      key: "anthropic/claude-mcp",
      name: "Claude MCP",
      sourceKind: "mcp",
      version: "1.1.0",
    });
    expect(v2.id).not.toBe(v1.id);
    expect(v2.version).toBe("1.1.0");
  });

  it("assign() defaults to pending_approval for non-trusted tiers and active for trusted", async () => {
    const trustedCap = await svc.register({
      companyId,
      key: "official/builtin",
      name: "Builtin",
      sourceKind: "builtin",
      trustTier: "trusted",
    });
    const reviewedCap = await svc.register({
      companyId,
      key: "third/party",
      name: "Third party",
      sourceKind: "plugin",
      trustTier: "reviewed",
    });

    const trustedAssign = await svc.assign({ companyId, capabilityId: trustedCap.id });
    expect(trustedAssign.status).toBe("active");

    const reviewedAssign = await svc.assign({ companyId, capabilityId: reviewedCap.id });
    expect(reviewedAssign.status).toBe("pending_approval");
  });

  it("assign() is idempotent per scope (company-wide or per-agent)", async () => {
    const cap = await svc.register({
      companyId,
      key: "k",
      name: "K",
      sourceKind: "plugin",
      trustTier: "trusted",
    });

    const first = await svc.assign({ companyId, capabilityId: cap.id, agentId });
    const second = await svc.assign({ companyId, capabilityId: cap.id, agentId });
    expect(second.id).toBe(first.id);

    // A company-wide assignment for the same capability is a different scope.
    const wide = await svc.assign({ companyId, capabilityId: cap.id });
    expect(wide.id).not.toBe(first.id);
  });

  it("listAssignmentsForScope(agentId) returns company-wide + agent-specific rows", async () => {
    const capA = await svc.register({ companyId, key: "a", name: "A", sourceKind: "plugin", trustTier: "trusted" });
    const capB = await svc.register({ companyId, key: "b", name: "B", sourceKind: "plugin", trustTier: "trusted" });
    const capC = await svc.register({ companyId, key: "c", name: "C", sourceKind: "plugin", trustTier: "trusted" });
    await svc.assign({ companyId, capabilityId: capA.id }); // company-wide
    await svc.assign({ companyId, capabilityId: capB.id, agentId }); // agent
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other",
      role: "engineer",
      status: "idle",
      adapter: "claude_local",
    });
    await svc.assign({ companyId, capabilityId: capC.id, agentId: otherAgentId });

    const forAgent = await svc.listAssignmentsForScope({ companyId, agentId });
    const capIds = new Set(forAgent.map((a) => a.capabilityId));
    expect(capIds.has(capA.id)).toBe(true);
    expect(capIds.has(capB.id)).toBe(true);
    expect(capIds.has(capC.id)).toBe(false);

    const wideOnly = await svc.listAssignmentsForScope({ companyId, agentId: null });
    expect(wideOnly.map((a) => a.capabilityId)).toEqual([capA.id]);
  });

  // WC-45: effective capability listing

  it("WC-45 listEffectiveForAgent excludes pending/revoked/hidden assignments", async () => {
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
    });
    const capActive = await svc.register({
      companyId, key: "active", name: "Active", sourceKind: "plugin", trustTier: "trusted",
    });
    const capHidden = await svc.register({
      companyId, key: "hidden", name: "Hidden", sourceKind: "plugin", trustTier: "trusted",
    });
    const capRevoked = await svc.register({
      companyId, key: "revoked", name: "Revoked", sourceKind: "plugin", trustTier: "trusted",
    });
    const capPending = await svc.register({
      companyId, key: "pending", name: "Pending", sourceKind: "plugin", trustTier: "reviewed",
    });
    const capOtherAgent = await svc.register({
      companyId, key: "otheronly", name: "Other only", sourceKind: "plugin", trustTier: "trusted",
    });

    // active + default visibility → included
    await svc.assign({ companyId, capabilityId: capActive.id, agentId });
    // assigned but hidden → excluded
    const hiddenAssignment = await svc.assign({ companyId, capabilityId: capHidden.id, agentId });
    await svc.setVisibility({ companyId, id: hiddenAssignment.id, visibility: "hidden" });
    // revoked → excluded
    const revokedAssignment = await svc.assign({ companyId, capabilityId: capRevoked.id, agentId });
    await svc.transitionStatus({ companyId, id: revokedAssignment.id, status: "revoked" });
    // pending → excluded (reviewed tier auto-defaults to pending)
    await svc.assign({ companyId, capabilityId: capPending.id, agentId });
    // assigned to different agent → excluded
    await svc.assign({ companyId, capabilityId: capOtherAgent.id, agentId: otherAgentId });

    const effective = await svc.listEffectiveForAgent({ companyId, agentId });
    expect(effective).toHaveLength(1);
    expect(effective[0].capability.key).toBe("active");
  });

  it("WC-45 listEffectiveForAgent includes company-wide assignments and deprecated visibility", async () => {
    const cap1 = await svc.register({
      companyId, key: "wide", name: "Wide", sourceKind: "plugin", trustTier: "trusted",
    });
    const cap2 = await svc.register({
      companyId, key: "deprecated", name: "Deprecated", sourceKind: "plugin", trustTier: "trusted",
    });
    // company-wide assignment
    await svc.assign({ companyId, capabilityId: cap1.id });
    // agent-specific, marked deprecated (still visible to runtime)
    const deprecatedAssignment = await svc.assign({ companyId, capabilityId: cap2.id, agentId });
    await svc.setVisibility({ companyId, id: deprecatedAssignment.id, visibility: "deprecated" });

    const effective = await svc.listEffectiveForAgent({ companyId, agentId });
    const keys = effective.map((e) => e.capability.key).sort();
    expect(keys).toEqual(["deprecated", "wide"]);
  });

  it("transitionStatus(revoked) stamps revokedAt; setVisibility flips visibility without touching status", async () => {
    const cap = await svc.register({ companyId, key: "k", name: "K", sourceKind: "plugin", trustTier: "trusted" });
    const assignment = await svc.assign({ companyId, capabilityId: cap.id });

    const hidden = await svc.setVisibility({ companyId, id: assignment.id, visibility: "hidden" });
    expect(hidden?.visibility).toBe("hidden");
    expect(hidden?.status).toBe("active");

    const revoked = await svc.transitionStatus({ companyId, id: assignment.id, status: "revoked", notes: "rotation" });
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokedAt).not.toBeNull();
    expect(revoked?.notes).toBe("rotation");
  });

  // ---------- WC-53 ----------

  it("WC-53: assign() reactivates a revoked scope instead of returning the stale revoked row", async () => {
    const cap = await svc.register({ companyId, key: "k", name: "K", sourceKind: "plugin", trustTier: "trusted" });
    const first = await svc.assign({ companyId, capabilityId: cap.id, agentId });
    expect(first.status).toBe("active");

    const revoked = await svc.transitionStatus({ companyId, id: first.id, status: "revoked" });
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokedAt).not.toBeNull();

    // Re-assigning the same scope must reactivate the SAME row (the unique
    // constraint blocks a fresh insert) — status back to the trust-tier
    // default and revokedAt cleared.
    const reGrant = await svc.assign({ companyId, capabilityId: cap.id, agentId });
    expect(reGrant.id).toBe(first.id);
    expect(reGrant.status).toBe("active");
    expect(reGrant.revokedAt).toBeNull();

    // And only one row exists for the scope.
    const effective = await svc.listEffectiveForAgent({ companyId, agentId });
    expect(effective.filter((e) => e.capability.id === cap.id)).toHaveLength(1);
  });

  it("WC-53: DB blocks duplicate company-wide assignments (NULLS NOT DISTINCT)", async () => {
    const cap = await svc.register({ companyId, key: "k", name: "K", sourceKind: "plugin", trustTier: "trusted" });
    // First company-wide row.
    await db.insert(capabilityAssignments).values({
      companyId,
      capabilityId: cap.id,
      agentId: null,
      status: "active",
      visibility: "default",
    });
    // A second raw insert for the same (company, capability, NULL agent)
    // scope must violate the unique constraint — previously NULLs were
    // distinct so this silently created a duplicate.
    await expect(
      db.insert(capabilityAssignments).values({
        companyId,
        capabilityId: cap.id,
        agentId: null,
        status: "active",
        visibility: "default",
      }),
    ).rejects.toThrow();
  });
});
