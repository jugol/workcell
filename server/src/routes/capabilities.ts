import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { capabilityAssignments } from "@workcell/db";
import { capabilityService } from "../services/capabilities.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

// WC-30: REST surface for the Capability Registry. Routes are minimal —
// list/register/assign/transition. Approval workflow integration and
// UI-side aggregation live in later slices.
export function capabilityRoutes(db: Db) {
  const router = Router();
  const svc = capabilityService(db);

  // Typed lookup for assignment company scoping (parameterized — never
  // pastes user input into raw SQL).
  async function findAssignmentCompanyId(id: string): Promise<string | null> {
    const rows = await db
      .select({ companyId: capabilityAssignments.companyId })
      .from(capabilityAssignments)
      .where(eq(capabilityAssignments.id, id))
      .limit(1);
    return rows[0]?.companyId ?? null;
  }

  // GET /companies/:companyId/capabilities — manifest list for a company.
  router.get("/companies/:companyId/capabilities", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const items = await svc.listForCompany(companyId);
    res.json({ items });
  });

  // POST /companies/:companyId/capabilities — register a capability
  // (idempotent on (key, version)).
  // WC-51: board-only. Registering a capability defines what the company
  // can grant; that's an administrative action, not something agents do.
  router.post("/companies/:companyId/capabilities", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const { key, name, description, sourceKind, sourceLocator, version, trustTier, metadata } = req.body ?? {};
    if (!key || !name || !sourceKind) {
      res.status(400).json({ error: "key, name, and sourceKind are required" });
      return;
    }
    // WC-64: an MCP capability must carry a runnable command — the registry
    // (WC-61) needs metadata.command/serverPath (or sourceLocator) to spawn
    // the server. Reject up front so a misconfigured 'mcp' row can't be
    // registered and then fail opaquely at connect time.
    if (sourceKind === "mcp") {
      const md = (metadata ?? {}) as Record<string, unknown>;
      const hasCommand =
        (typeof md.command === "string" && md.command.trim().length > 0) ||
        (typeof md.serverPath === "string" && md.serverPath.trim().length > 0) ||
        (typeof sourceLocator === "string" && sourceLocator.trim().length > 0);
      if (!hasCommand) {
        res.status(400).json({
          error: "an 'mcp' capability requires metadata.command (or metadata.serverPath / sourceLocator)",
        });
        return;
      }
    }
    const capability = await svc.register({
      companyId,
      key,
      name,
      description,
      sourceKind,
      sourceLocator,
      version,
      trustTier,
      metadata,
    });
    res.status(201).json({ capability });
  });

  // POST /companies/:companyId/capabilities/:id/assign — assign to a scope.
  // WC-51 (security): board-only. Previously an agent actor could reach
  // this route (assertCompanyAccess does not restrict agents to board) and
  // forward `status: "active"`, self-granting a non-trusted capability and
  // bypassing the WC-36 board-approval workflow. Now:
  //   - assertBoard rejects agent actors (403).
  //   - grant attribution (grantedByUserId/grantedByAgentId) is derived from
  //     the authenticated actor, never accepted from the request body, so the
  //     audit trail can't be forged.
  router.post("/companies/:companyId/capabilities/:id/assign", async (req, res) => {
    const companyId = req.params.companyId as string;
    const capabilityId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const cap = await svc.getById(companyId, capabilityId);
    if (!cap) {
      res.status(404).json({ error: "Capability not found" });
      return;
    }
    const assignment = await svc.assign({
      companyId,
      capabilityId,
      agentId: req.body.agentId ?? null,
      status: req.body.status,
      visibility: req.body.visibility,
      grantedByUserId: actor.actorType === "user" ? actor.actorId : null,
      grantedByAgentId: actor.agentId,
      notes: req.body.notes ?? null,
    });
    res.status(201).json({ assignment });
  });

  // GET /companies/:companyId/capability-assignments — list, optionally
  // filtered by ?agentId=<id> (null sentinel = company-wide only).
  router.get("/companies/:companyId/capability-assignments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const raw = (req.query.agentId as string | undefined) ?? undefined;
    const agentId = raw === undefined ? undefined : raw === "null" || raw === "" ? null : raw;
    const items = await svc.listAssignmentsForScope({ companyId, agentId });
    res.json({ items });
  });

  // PATCH /capability-assignments/:id — status / visibility update. Body:
  //   { status?: CapabilityAssignmentStatus, visibility?: CapabilityVisibility, notes? }
  router.patch("/capability-assignments/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await findAssignmentCompanyId(id);
    if (!companyId) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    // WC-51 (security): board-only. Without this an agent could revoke a
    // peer's grant or flip an assignment's status/visibility, influencing
    // the active capability set without board oversight (mirrors /approve).
    assertBoard(req);
    let assignment = null;
    if (req.body.status !== undefined) {
      assignment = await svc.transitionStatus({
        companyId,
        id,
        status: req.body.status,
        notes: req.body.notes,
      });
    }
    if (req.body.visibility !== undefined) {
      assignment = await svc.setVisibility({
        companyId,
        id,
        visibility: req.body.visibility,
      });
    }
    if (!assignment) {
      res.status(400).json({ error: "No mutable field provided (status or visibility)" });
      return;
    }
    res.json({ assignment });
  });

  // WC-45 (§9 #7): effective capability listing for an agent at execution
  // time. Filters to status=active + visibility != hidden + scope match.
  router.get(
    "/companies/:companyId/agents/:agentId/effective-capabilities",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      const items = await svc.listEffectiveForAgent({ companyId, agentId });
      res.json({ items });
    },
  );

  // WC-36: explicit approval action for pending_approval assignments.
  // Requires a board (user) actor — agent-driven approvals are not
  // accepted on this route. Returns 409 when the assignment isn't
  // currently pending.
  router.post("/capability-assignments/:id/approve", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await findAssignmentCompanyId(id);
    if (!companyId) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const actor = (req as any).actor;
    if (actor?.type !== "board") {
      res.status(403).json({ error: "Only board actors can approve capability assignments" });
      return;
    }
    try {
      const assignment = await svc.approve({
        companyId,
        id,
        approverUserId: actor.userId ?? "board",
      });
      if (!assignment) {
        res.status(404).json({ error: "Assignment not found" });
        return;
      }
      res.json({ assignment });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(409).json({ error: msg });
    }
  });

  return router;
}
