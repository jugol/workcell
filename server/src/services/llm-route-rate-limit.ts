import type { Request } from "express";
import {
  createSlidingWindowRateLimiter,
  type SlidingWindowRateLimitResult,
} from "./sliding-window-rate-limiter.js";

// WC-215: per-tenant rate limiting for the expensive, LLM-driven HTTP routes
// (deliberation start, pair-group run, compound-checklist auto-fill, context
// compaction, draft-from-prompt, parallel auto-dispatch). Each of these kicks off
// a live-model run that costs real $ and takes ~1-5 minutes, so a malicious or
// buggy caller could otherwise spawn unbounded runs (cost-runaway / DoS).
//
// The limit is deliberately GENEROUS but real: 12 requests / 60s / tenant cannot
// be reached by legitimate interactive or autonomous use, but it caps a runaway.
// Keyed per `company:actorType:actorId` so one tenant (or one agent/board actor)
// cannot exhaust another's budget.
//
// In-memory, per-instance (Map on the limiter instance) — same model as the
// company-search limiter, correct for the current single-instance deployment.
// Distributed/Redis-backed limiting is a later concern.

export const LLM_ROUTE_RATE_LIMIT_WINDOW_MS = 60_000;
export const LLM_ROUTE_RATE_LIMIT_MAX_REQUESTS = 12;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type LlmRouteRateLimitActor = {
  companyId: string;
  actorType: "agent" | "board";
  actorId: string;
};

export type LlmRouteRateLimitResult = SlidingWindowRateLimitResult;

export type LlmRouteRateLimiter = {
  consume(actor: LlmRouteRateLimitActor): LlmRouteRateLimitResult;
};

export function createLlmRouteRateLimiter(options: {
  windowMs?: number;
  maxRequests?: number;
  now?: () => number;
} = {}): LlmRouteRateLimiter {
  return createSlidingWindowRateLimiter<LlmRouteRateLimitActor>({
    key: (actor) => `${actor.companyId}:${actor.actorType}:${actor.actorId}`,
    windowMs: options.windowMs ?? envInt("WORKCELL_LLM_RATE_LIMIT_WINDOW_MS", LLM_ROUTE_RATE_LIMIT_WINDOW_MS),
    maxRequests: options.maxRequests ?? envInt("WORKCELL_LLM_RATE_LIMIT_MAX", LLM_ROUTE_RATE_LIMIT_MAX_REQUESTS),
    now: options.now,
  });
}

// Shared default instance: all LLM routes that don't get an injected limiter
// (i.e. production) consume from this one process-wide limiter, so the
// per-tenant cap holds across every expensive route, not per-route.
export const defaultLlmRouteRateLimiter = createLlmRouteRateLimiter();

// Resolve the rate-limit actor from the authenticated request. Mirrors
// companySearchRateLimitActor: agents are keyed by agentId (falling back to the
// key id), board callers by userId (falling back to the auth source). Reads only
// the globally-augmented req.actor, so it is reusable across every route file.
export function llmRouteRateLimitActor(req: Request, companyId: string): LlmRouteRateLimitActor {
  if (req.actor.type === "agent") {
    return {
      companyId,
      actorType: "agent",
      actorId: req.actor.agentId ?? req.actor.keyId ?? "unknown-agent",
    };
  }
  return {
    companyId,
    actorType: "board",
    actorId: req.actor.userId ?? req.actor.source ?? "board",
  };
}

// Apply the per-tenant LLM rate limit at the top of an HTTP handler. Sets the
// standard X-RateLimit-* headers always; on rejection sets Retry-After and writes
// the 429 body, returning false so the caller can `return` immediately. Returns
// true when the call is allowed to proceed.
//
// Usage at the TOP of a handler:
//   if (!enforceLlmRouteRateLimit(req, res, limiter, companyId)) return;
export function enforceLlmRouteRateLimit(
  req: Request,
  res: import("express").Response,
  limiter: LlmRouteRateLimiter,
  companyId: string,
): boolean {
  const rateLimit = limiter.consume(llmRouteRateLimitActor(req, companyId));
  res.setHeader("X-RateLimit-Limit", String(rateLimit.limit));
  res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
  if (!rateLimit.allowed) {
    res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
    res.status(429).json({
      error: "LLM route rate limit exceeded",
      message:
        "Too many expensive model-backed requests for this tenant. Retry after the window resets.",
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return false;
  }
  return true;
}
