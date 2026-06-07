import { afterEach, describe, expect, it } from "vitest";
import { createSlidingWindowRateLimiter } from "../services/sliding-window-rate-limiter.js";
import {
  LLM_ROUTE_RATE_LIMIT_MAX_REQUESTS,
  LLM_ROUTE_RATE_LIMIT_WINDOW_MS,
  createLlmRouteRateLimiter,
  llmRouteRateLimitActor,
  type LlmRouteRateLimitActor,
} from "../services/llm-route-rate-limit.js";

describe("createSlidingWindowRateLimiter (WC-215 generic core)", () => {
  const actor: LlmRouteRateLimitActor = { companyId: "c1", actorType: "agent", actorId: "a1" };
  const keyOf = (a: LlmRouteRateLimitActor) => `${a.companyId}:${a.actorType}:${a.actorId}`;

  it("allows up to maxRequests then rejects with a Retry-After in the window", () => {
    let nowMs = 1_000;
    const limiter = createSlidingWindowRateLimiter<LlmRouteRateLimitActor>({
      key: keyOf,
      windowMs: 60_000,
      maxRequests: 2,
      now: () => nowMs,
    });

    const first = limiter.consume(actor);
    expect(first).toEqual({ allowed: true, limit: 2, remaining: 1, retryAfterSeconds: 0 });

    const second = limiter.consume(actor);
    expect(second).toEqual({ allowed: true, limit: 2, remaining: 0, retryAfterSeconds: 0 });

    const third = limiter.consume(actor);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    // Oldest hit was at t=1000, window 60s → retry after ~60s.
    expect(third.retryAfterSeconds).toBe(60);
  });

  it("frees capacity once the oldest hit slides out of the window", () => {
    let nowMs = 0;
    const limiter = createSlidingWindowRateLimiter<LlmRouteRateLimitActor>({
      key: keyOf,
      windowMs: 1_000,
      maxRequests: 1,
      now: () => nowMs,
    });

    expect(limiter.consume(actor).allowed).toBe(true);
    nowMs = 500;
    expect(limiter.consume(actor).allowed).toBe(false);
    // Advance past the window so the first hit expires.
    nowMs = 1_001;
    expect(limiter.consume(actor).allowed).toBe(true);
  });

  it("keys buckets independently so distinct actors do not share a budget", () => {
    let nowMs = 0;
    const limiter = createSlidingWindowRateLimiter<LlmRouteRateLimitActor>({
      key: keyOf,
      windowMs: 60_000,
      maxRequests: 1,
      now: () => nowMs,
    });

    expect(limiter.consume({ companyId: "c1", actorType: "agent", actorId: "a1" }).allowed).toBe(true);
    // Same company, different actor → separate bucket, still allowed.
    expect(limiter.consume({ companyId: "c1", actorType: "agent", actorId: "a2" }).allowed).toBe(true);
    // Different company entirely → separate bucket, still allowed.
    expect(limiter.consume({ companyId: "c2", actorType: "agent", actorId: "a1" }).allowed).toBe(true);
    // Repeat of the first actor → now rejected.
    expect(limiter.consume({ companyId: "c1", actorType: "agent", actorId: "a1" }).allowed).toBe(false);
  });
});

describe("createLlmRouteRateLimiter (WC-215)", () => {
  const ENV_KEYS = ["WORKCELL_LLM_RATE_LIMIT_WINDOW_MS", "WORKCELL_LLM_RATE_LIMIT_MAX"] as const;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
  });

  function stashEnv() {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  }

  it("defaults to a generous-but-real 12 requests / 60s", () => {
    expect(LLM_ROUTE_RATE_LIMIT_MAX_REQUESTS).toBe(12);
    expect(LLM_ROUTE_RATE_LIMIT_WINDOW_MS).toBe(60_000);

    let nowMs = 0;
    const limiter = createLlmRouteRateLimiter({ now: () => nowMs });
    const actor: LlmRouteRateLimitActor = { companyId: "c1", actorType: "board", actorId: "u1" };
    for (let i = 0; i < 12; i += 1) {
      expect(limiter.consume(actor).allowed).toBe(true);
    }
    expect(limiter.consume(actor).allowed).toBe(false);
  });

  it("honors the env overrides for window + max", () => {
    stashEnv();
    process.env.WORKCELL_LLM_RATE_LIMIT_MAX = "3";
    process.env.WORKCELL_LLM_RATE_LIMIT_WINDOW_MS = "30000";

    let nowMs = 0;
    const limiter = createLlmRouteRateLimiter({ now: () => nowMs });
    const actor: LlmRouteRateLimitActor = { companyId: "c1", actorType: "board", actorId: "u1" };
    expect(limiter.consume(actor).limit).toBe(3);
    expect(limiter.consume(actor).allowed).toBe(true);
    expect(limiter.consume(actor).allowed).toBe(true);
    const rejected = limiter.consume(actor);
    expect(rejected.allowed).toBe(false);
    // 30s window from the first hit at t=0.
    expect(rejected.retryAfterSeconds).toBe(30);
  });

  it("explicit options win over env overrides", () => {
    stashEnv();
    process.env.WORKCELL_LLM_RATE_LIMIT_MAX = "1";
    const limiter = createLlmRouteRateLimiter({ maxRequests: 5, now: () => 0 });
    const actor: LlmRouteRateLimitActor = { companyId: "c1", actorType: "agent", actorId: "a1" };
    expect(limiter.consume(actor).limit).toBe(5);
  });
});

describe("llmRouteRateLimitActor (WC-215)", () => {
  it("keys agents by agentId, falling back to keyId then a stable sentinel", () => {
    expect(
      llmRouteRateLimitActor({ actor: { type: "agent", agentId: "agent-9" } } as any, "co"),
    ).toEqual({ companyId: "co", actorType: "agent", actorId: "agent-9" });

    expect(
      llmRouteRateLimitActor({ actor: { type: "agent", keyId: "key-7" } } as any, "co"),
    ).toEqual({ companyId: "co", actorType: "agent", actorId: "key-7" });

    expect(
      llmRouteRateLimitActor({ actor: { type: "agent" } } as any, "co"),
    ).toEqual({ companyId: "co", actorType: "agent", actorId: "unknown-agent" });
  });

  it("keys board callers by userId, falling back to source then a stable sentinel", () => {
    expect(
      llmRouteRateLimitActor({ actor: { type: "board", userId: "user-3" } } as any, "co"),
    ).toEqual({ companyId: "co", actorType: "board", actorId: "user-3" });

    expect(
      llmRouteRateLimitActor({ actor: { type: "board", source: "session" } } as any, "co"),
    ).toEqual({ companyId: "co", actorType: "board", actorId: "session" });

    expect(
      llmRouteRateLimitActor({ actor: { type: "board" } } as any, "co"),
    ).toEqual({ companyId: "co", actorType: "board", actorId: "board" });
  });
});
