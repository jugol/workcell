// Generic per-key sliding-window rate limiter.
//
// Extracted from company-search-rate-limit.ts (WC-215) so the same battle-tested
// window logic backs both company search and the expensive LLM routes without
// duplication. Behavior is intentionally identical to the original company-search
// implementation — this is a pure internal extraction.
//
// In-memory, per-instance: counters live in a Map on the limiter instance. This
// matches the existing company-search limiter and is correct for the current
// single-instance (local_trusted) deployment. Distributed/Redis-backed limiting
// is a later concern.

export type SlidingWindowRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export type SlidingWindowRateLimiter<TActor> = {
  consume(actor: TActor): SlidingWindowRateLimitResult;
};

export function createSlidingWindowRateLimiter<TActor>(options: {
  /** Derive the per-actor bucket key (e.g. `${companyId}:${actorType}:${actorId}`). */
  key: (actor: TActor) => string;
  windowMs: number;
  maxRequests: number;
  now?: () => number;
}): SlidingWindowRateLimiter<TActor> {
  const { key, windowMs, maxRequests } = options;
  const now = options.now ?? Date.now;
  const hitsByKey = new Map<string, number[]>();

  return {
    consume(actor) {
      const currentTime = now();
      const cutoff = currentTime - windowMs;
      const actorKey = key(actor);
      const recentHits = (hitsByKey.get(actorKey) ?? []).filter((hit) => hit > cutoff);

      if (recentHits.length >= maxRequests) {
        const oldestHit = recentHits[0] ?? currentTime;
        hitsByKey.set(actorKey, recentHits);
        return {
          allowed: false,
          limit: maxRequests,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((oldestHit + windowMs - currentTime) / 1000)),
        };
      }

      recentHits.push(currentTime);
      hitsByKey.set(actorKey, recentHits);
      return {
        allowed: true,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - recentHits.length),
        retryAfterSeconds: 0,
      };
    },
  };
}
