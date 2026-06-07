import {
  createSlidingWindowRateLimiter,
  type SlidingWindowRateLimitResult,
} from "./sliding-window-rate-limiter.js";

export const COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS = 60_000;
export const COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS = 60;

export type CompanySearchRateLimitActor = {
  companyId: string;
  actorType: "agent" | "board";
  actorId: string;
};

// Kept as a named alias for the shared result shape so existing importers
// (route handlers, tests) compile unchanged after the WC-215 extraction.
export type CompanySearchRateLimitResult = SlidingWindowRateLimitResult;

export type CompanySearchRateLimiter = {
  consume(actor: CompanySearchRateLimitActor): CompanySearchRateLimitResult;
};

export function createCompanySearchRateLimiter(options: {
  windowMs?: number;
  maxRequests?: number;
  now?: () => number;
} = {}): CompanySearchRateLimiter {
  // Thin wrapper over the generic sliding-window limiter (WC-215). The window
  // logic is shared; only the defaults + per-actor key live here.
  return createSlidingWindowRateLimiter<CompanySearchRateLimitActor>({
    key: (actor) => `${actor.companyId}:${actor.actorType}:${actor.actorId}`,
    windowMs: options.windowMs ?? COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS,
    maxRequests: options.maxRequests ?? COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS,
    now: options.now,
  });
}
