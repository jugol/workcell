import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { issues } from "@workcell/db";
import { parallelDispatchService } from "../services/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  defaultLlmRouteRateLimiter,
  enforceLlmRouteRateLimit,
  type LlmRouteRateLimiter,
} from "../services/llm-route-rate-limit.js";

// WC-42 (PLAN §9 #5): expose the parallel-dispatch candidate list.
//
// The dispatcher consumer (UI or automation) can request the candidate
// list and decide what to wake up. The route is intentionally read-only:
// actually firing the wakeups goes through existing per-issue/agent
// routes so the audit trail and authorization stay consistent.
export function parallelDispatchRoutes(
  db: Db,
  opts: {
    // WC-215: injectable per-tenant limiter for the auto-dispatch wake route.
    // Tests pass a tiny-limit fake; production uses the shared default.
    llmRateLimiter?: LlmRouteRateLimiter;
  } = {},
) {
  const router = Router();
  const svc = parallelDispatchService(db);
  const heartbeat = heartbeatService(db, {});
  const llmRateLimiter = opts.llmRateLimiter ?? defaultLlmRouteRateLimiter;

  router.get(
    "/companies/:companyId/parallel-dispatch-candidates",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const plan = await svc.candidatesForCompany(companyId);
      res.json(plan);
    },
  );

  // WC-44 (§9 #5): auto-dispatcher. POST fires heartbeat wakeups in
  // parallel for the deduplicated candidate set. Returns the dispatched
  // issue ids + per-issue success/failure. Caller can also pass
  // body.maxToDispatch to limit how many wakeups fire in one shot.
  router.post(
    "/companies/:companyId/parallel-dispatch-candidates/wake",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      // WC-215: cap parallel auto-dispatch (fan-out of live runs) per tenant.
      if (!enforceLlmRouteRateLimit(req, res, llmRateLimiter, companyId)) return;
      const actor = getActorInfo(req);

      const plan = await svc.candidatesForCompany(companyId);
      const cap = Math.max(
        1,
        Math.min(20, Number(req.body?.maxToDispatch ?? plan.dispatchable.length)),
      );
      const toDispatch = plan.dispatchable.slice(0, cap);
      if (toDispatch.length === 0) {
        res.json({ dispatched: [], skipped: plan.candidates.length });
        return;
      }

      // Wakeups go through the existing queueIssueAssignmentWakeup path
      // so audit trail + cancellation semantics stay consistent. Errors
      // per-issue are captured into the response rather than aborting
      // the whole batch.
      const results: Array<{
        issueId: string;
        agentId: string;
        ok: boolean;
        error?: string;
      }> = [];
      const promises = toDispatch.map(async (cand) => {
        try {
          // Load the issue row so the wakeup helper can check status.
          const issueRow = await db
            .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
            .from(issues)
            .where(eq(issues.id, cand.issueId))
            .limit(1)
            .then((rows) => rows[0]);
          if (!issueRow) {
            results.push({ issueId: cand.issueId, agentId: cand.assigneeAgentId, ok: false, error: "issue gone" });
            return;
          }
          // Use the existing helper which has the right short-circuit
          // semantics + logger wiring.
          await heartbeat.wakeup(cand.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "parallel_dispatch_auto",
            payload: { issueId: cand.issueId, mutation: "parallel_dispatch" },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: { issueId: cand.issueId, source: "parallel_dispatch" },
          });
          results.push({ issueId: cand.issueId, agentId: cand.assigneeAgentId, ok: true });
        } catch (err) {
          results.push({
            issueId: cand.issueId,
            agentId: cand.assigneeAgentId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
      await Promise.all(promises);

      res.status(200).json({
        dispatched: results,
        skipped: plan.candidates.length - toDispatch.length,
      });
    },
  );

  return router;
}
