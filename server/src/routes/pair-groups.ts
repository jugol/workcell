import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { pairGroups } from "@workcell/db";
import {
  pairGroupService,
  issueService,
  logActivity,
  pairRoundOrchestrator,
  type PairTurnExecutor,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  defaultLlmRouteRateLimiter,
  enforceLlmRouteRateLimit,
  type LlmRouteRateLimiter,
} from "../services/llm-route-rate-limit.js";
import { pairRunRegistry } from "../services/pair-run-registry.js";

// WC-26 (P2 §3 fourth slice): REST routes for pair groups.
//
// All routes nest under an issue so company scoping is implicit and the
// pair group is always discoverable by its target. The routes are
// intentionally minimal — no UI-specific aggregation yet, just the raw
// CRUD + turn ledger surface. Future UI slices compose these.
export function pairGroupRoutes(
  db: Db,
  opts: {
    pairTurnExecutor?: PairTurnExecutor;
    // WC-215: injectable per-tenant limiter for the live pair-round route.
    // Tests pass a tiny-limit fake; production uses the shared default.
    llmRateLimiter?: LlmRouteRateLimiter;
  } = {},
) {
  const router = Router();
  const svc = pairGroupService(db);
  const issuesSvc = issueService(db);
  const llmRateLimiter = opts.llmRateLimiter ?? defaultLlmRouteRateLimiter;
  // Use the provided executor or a no-op default that returns an empty
  // summary. The no-op default lets the route handler return a clear
  // 501-style message instead of throwing when adapter wiring is missing.
  const turnExecutor: PairTurnExecutor =
    opts.pairTurnExecutor ??
    (async () => {
      throw new Error(
        "no pair turn executor configured — supply opts.pairTurnExecutor when mounting pairGroupRoutes",
      );
    });
  const orchestrator = pairRoundOrchestrator(db, turnExecutor);

  // Helper: look up companyId for a pair group id (typed/parameterized so
  // request input never goes near a raw SQL string).
  async function findGroupCompanyId(groupId: string): Promise<string | null> {
    const rows = await db
      .select({ companyId: pairGroups.companyId })
      .from(pairGroups)
      .where(eq(pairGroups.id, groupId))
      .limit(1);
    return rows[0]?.companyId ?? null;
  }

  // WC-189 (checkpoint #5): GET /companies/:companyId/pair-groups?status=active
  // — list pair bindings for the company in the agent-side shape. Powers the
  // agent list + org chart pair markers. Tenant-scoped via assertCompanyAccess.
  // `status` defaults to "active" and accepts the PairGroup lifecycle values.
  router.get("/companies/:companyId/pair-groups", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // `scope=standing` returns the durable mutually-exclusive pairs (latest
    // binding per agent pair across EVERY status — the org chart's
    // single-node semantics). Powers the assignee picker's merged
    // "Owner ⇄ Counterpart" option. When scope is present it takes
    // precedence and `status` is ignored; the plain status listing below is
    // unchanged.
    if (req.query.scope !== undefined) {
      if (req.query.scope !== "standing") {
        res.status(400).json({
          error: `Unsupported scope: ${String(req.query.scope)}. Expected "standing".`,
        });
        return;
      }
      const bindings = await svc.listStandingMutualBindings(companyId);
      res.json({ bindings });
      return;
    }
    const requested = typeof req.query.status === "string" ? req.query.status : "active";
    const allowed = ["active", "completed", "aborted"] as const;
    if (!allowed.includes(requested as (typeof allowed)[number])) {
      res.status(400).json({
        error: `Unsupported status: ${requested}. Expected one of ${allowed.join(", ")}.`,
      });
      return;
    }
    const bindings = await svc.listBindingsForCompany(companyId, {
      status: requested as (typeof allowed)[number],
    });
    res.json({ bindings });
  });

  // GET /issues/:id/pair-group — fetch the active pair group on the issue
  // (or 200 with `{ group: null }` when none exists).
  router.get("/issues/:id/pair-group", async (req, res) => {
    const id = req.params.id as string;
    const issue = await issuesSvc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const group = await svc.getActiveForIssue(issue.companyId, issue.id);
    // Surface the in-flight round state (manual route or auto-run ticker) so
    // the UI can disable its run buttons while ANY driver is advancing the
    // group — not just this tab's own mutation.
    const inFlight = group ? pairRunRegistry.get(group.id) : null;
    res.json({
      group: group
        ? {
            ...group,
            runInFlight: inFlight !== null,
            runInFlightSource: inFlight?.source ?? null,
            // The heartbeat_runs.id of the turn currently executing inside the
            // in-flight round (live path only) — lets the UI deep-link to the
            // live run stream. Null between turns and on the stub path.
            runInFlightRunId: inFlight?.runId ?? null,
          }
        : null,
    });
  });

  // POST /issues/:id/pair-group — create a pair group on the issue. Flips
  // workOwnerKind to "pair" atomically. 409 if an active group already
  // exists for this issue (the caller should re-use it or explicitly
  // transition it to completed/aborted first).
  router.post("/issues/:id/pair-group", async (req, res) => {
    const id = req.params.id as string;
    const issue = await issuesSvc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const existing = await svc.getActiveForIssue(issue.companyId, issue.id);
    if (existing) {
      res.status(409).json({
        error: "An active pair group already exists for this issue",
        groupId: existing.id,
      });
      return;
    }

    // dual_brain (one agent self-reviewing) is no longer a pair-group concern —
    // it is moving to the heartbeat execution layer so it serializes with the
    // issue's QA/execution stage instead of running concurrently. Reject both
    // the explicit kind and the owner===counterpart form the service would
    // otherwise infer as dual_brain. agent_pair creation is unaffected.
    const wouldBeDualBrain =
      req.body.kind === "dual_brain" ||
      (typeof req.body.ownerAgentId === "string" &&
        req.body.ownerAgentId.length > 0 &&
        req.body.ownerAgentId === req.body.counterpartAgentId);
    if (wouldBeDualBrain) {
      res.status(400).json({
        error:
          "dual-brain self-review is not a pair group — it runs inline in the agent's heartbeat run. Pick two DIFFERENT agents for a pair.",
        code: "dual_brain_not_a_pair_group",
      });
      return;
    }

    const group = await svc.create({
      companyId: issue.companyId,
      issueId: issue.id,
      ownerAgentId: req.body.ownerAgentId ?? null,
      counterpartAgentId: req.body.counterpartAgentId ?? null,
      maxRounds: req.body.maxRounds,
      stopPolicy: req.body.stopPolicy ?? null,
      autoRunEnabled: req.body.autoRunEnabled,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId ?? "system",
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.pair_group_created",
      entityType: "issue",
      entityId: issue.id,
      details: { pairGroupId: group.id, maxRounds: group.maxRounds },
    });

    res.status(201).json({ group });
  });

  // POST /pair-groups/:id/turns — record a turn against the active group.
  // Body: { actorAgentId, runId?, summary?, outcome?, costCents?, metadata? }.
  router.post("/pair-groups/:id/turns", async (req, res) => {
    const id = req.params.id as string;
    const actor = getActorInfo(req);
    // The group itself carries companyId; we must fetch it first to scope
    // assertCompanyAccess properly.
    const companyId = await findGroupCompanyId(id);
    if (!companyId) {
      res.status(404).json({ error: "Pair group not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    try {
      const result = await svc.recordTurn({
        companyId: companyId,
        pairGroupId: id,
        actorAgentId: req.body.actorAgentId ?? actor.agentId ?? null,
        runId: req.body.runId ?? null,
        summary: req.body.summary ?? null,
        outcome: req.body.outcome,
        costCents: req.body.costCents,
        metadata: req.body.metadata,
      });
      res.status(201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        res.status(404).json({ error: msg });
        return;
      }
      res.status(409).json({ error: msg });
    }
  });

  // POST /pair-groups/:id/advance — bump currentRound. Returns the updated
  // group (or 404 if missing).
  router.post("/pair-groups/:id/advance", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await findGroupCompanyId(id);
    if (!companyId) {
      res.status(404).json({ error: "Pair group not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const group = await svc.advanceRound({ companyId: companyId, pairGroupId: id });
    res.json({ group });
  });

  // PATCH /pair-groups/:id — transition status and/or toggle auto-run.
  // Body: { status?, stopReason?, autoRunEnabled? }. At least one of `status`
  // or `autoRunEnabled` (boolean) is required; when both are present both are
  // applied and the final group state is returned.
  router.patch("/pair-groups/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await findGroupCompanyId(id);
    if (!companyId) {
      res.status(404).json({ error: "Pair group not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const hasAutoRun = typeof req.body.autoRunEnabled === "boolean";
    if (!req.body.status && !hasAutoRun) {
      res.status(400).json({ error: "status or autoRunEnabled required" });
      return;
    }
    let group = null;
    if (hasAutoRun) {
      group = await svc.setAutoRun({
        companyId: companyId,
        id,
        enabled: req.body.autoRunEnabled,
      });
    }
    if (req.body.status) {
      group = await svc.transitionStatus({
        companyId: companyId,
        id,
        status: req.body.status,
        stopReason: req.body.stopReason ?? null,
      });
    }
    res.json({ group });
  });

  // GET /pair-groups/:id/turns — list turns for the group in (round, createdAt) order.
  router.get("/pair-groups/:id/turns", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await findGroupCompanyId(id);
    if (!companyId) {
      res.status(404).json({ error: "Pair group not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const turns = await svc.listTurnsForGroup(companyId, id);
    res.json({ turns });
  });

  // WC-32: drive one round of pair work via the configured executor.
  // Body: { maxRoundsToRun?: number } — default 1. The route always
  // returns 200 with `{ results: PairRoundResult[] }` so the caller can
  // see partial progress (e.g. owner turn ran but counterpart was
  // pending). 503 is returned only when no executor is wired AND the
  // call would actually invoke it.
  router.post("/pair-groups/:id/run-round", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await findGroupCompanyId(id);
    if (!companyId) {
      res.status(404).json({ error: "Pair group not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    // WC-215: cap expensive live pair-turn rounds per tenant.
    if (!enforceLlmRouteRateLimit(req, res, llmRateLimiter, companyId)) return;
    // Single-flight per group: a round already running (manual from another
    // tab, or the auto-run ticker) must not trigger a second pair of LLM
    // turns. 409 instead — the UI treats this as "sync state, not an error".
    if (!pairRunRegistry.tryAcquire(id, "manual")) {
      res.status(409).json({
        error: "A round is already in flight for this pair group",
        code: "pair_round_in_flight",
      });
      return;
    }
    const max = Math.max(1, Math.min(10, Number(req.body?.maxRoundsToRun ?? 1)));
    try {
      const results = await orchestrator.runUntilStop({
        companyId,
        pairGroupId: id,
        maxRoundsToRun: max,
      });
      res.status(200).json({ results });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no pair turn executor")) {
        res.status(503).json({ error: msg });
        return;
      }
      res.status(500).json({ error: msg });
    } finally {
      pairRunRegistry.release(id);
    }
  });

  return router;
}
