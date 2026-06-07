import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { parallelDispatchRoutes } from "../routes/parallel-dispatch.js";
import { errorHandler } from "../middleware/index.js";
import { createLlmRouteRateLimiter } from "../services/llm-route-rate-limit.js";

// WC-215: the expensive LLM routes enforce a per-tenant rate limit at the TOP of
// the handler (before the DB / live-model work). We inject a maxRequests:1 fake
// limiter through the route factory opts and prove the SECOND same-tenant call is
// rejected with 429 + Retry-After. These routes derive companyId from the path
// and run the limiter before any DB access, so the first (token-consuming) call
// can hit a stub DB and fail later without affecting the limiter assertion on the
// second call.
function makeApp(
  mount: (app: express.Express) => void,
  actor: Record<string, unknown>,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  mount(app);
  app.use(errorHandler);
  return app;
}

const BOARD_ACTOR = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: true,
};

describe("LLM route per-tenant rate limiting (WC-215)", () => {
  it("draft-from-prompt: rejects the 2nd same-tenant call with 429 + Retry-After", async () => {
    const limiter = createLlmRouteRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 1_000 });
    const app = makeApp(
      (a) => a.use("/api", issueRoutes({} as never, {} as never, { llmRateLimiter: limiter })),
      BOARD_ACTOR,
    );

    // 1st call consumes the only token; the stub DB makes the handler fail AFTER
    // the limiter passed (status here is not the assertion).
    await request(app)
      .post("/api/companies/company-1/issues/draft-from-prompt")
      .send({ prompt: "Add a CSV export button to the reports page." });

    // 2nd call is rejected by the limiter before touching the DB.
    const limited = await request(app)
      .post("/api/companies/company-1/issues/draft-from-prompt")
      .send({ prompt: "Add a CSV export button to the reports page." })
      .expect(429);

    expect(limited.body).toMatchObject({
      error: "LLM route rate limit exceeded",
      retryAfterSeconds: 60,
    });
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.headers["x-ratelimit-limit"]).toBe("1");
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("parallel-dispatch wake: rejects the 2nd same-tenant call with 429 + Retry-After", async () => {
    const limiter = createLlmRouteRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 1_000 });
    const app = makeApp(
      (a) => a.use("/api", parallelDispatchRoutes({} as never, { llmRateLimiter: limiter })),
      BOARD_ACTOR,
    );

    await request(app)
      .post("/api/companies/company-1/parallel-dispatch-candidates/wake")
      .send({});

    const limited = await request(app)
      .post("/api/companies/company-1/parallel-dispatch-candidates/wake")
      .send({})
      .expect(429);

    expect(limited.body).toMatchObject({
      error: "LLM route rate limit exceeded",
      retryAfterSeconds: 60,
    });
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("does not leak the limit across tenants (separate companyId → own budget)", async () => {
    const limiter = createLlmRouteRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 1_000 });
    const multiTenantActor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1", "company-2"],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    const app = makeApp(
      (a) => a.use("/api", parallelDispatchRoutes({} as never, { llmRateLimiter: limiter })),
      multiTenantActor,
    );

    // Exhaust company-1's single token.
    await request(app).post("/api/companies/company-1/parallel-dispatch-candidates/wake").send({});
    await request(app)
      .post("/api/companies/company-1/parallel-dispatch-candidates/wake")
      .send({})
      .expect(429);

    // company-2 has its own bucket: the first call is NOT 429 (it fails later on
    // the stub DB, i.e. 500 — anything but 429 proves the limiter let it through).
    const otherTenant = await request(app)
      .post("/api/companies/company-2/parallel-dispatch-candidates/wake")
      .send({});
    expect(otherTenant.status).not.toBe(429);
  });
});
