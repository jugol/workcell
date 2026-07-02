import { describe, expect, it, vi, beforeAll } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

/**
 * WC-212 (production-readiness Wave 1, fix #1): the request logger must NOT
 * write plaintext secrets to server.log on a failed (4xx/5xx) request.
 *
 * `server/src/middleware/logger.ts` previously attached the raw `req.body`,
 * `req.query`, and `req.params` (and the error-handler-stashed copies of them)
 * as structured log props on every 4xx/5xx response. A failed POST to a
 * secret-bearing route (e.g. /companies/:id/secrets, /secrets/:id/rotate,
 * agent-key create, webhook create, or any `{type:"plain"}` env binding) would
 * therefore persist the plaintext secret to disk.
 *
 * This test captures the exact pino-http config the module installs, drives the
 * `customProps` hook the way pino-http does, and asserts every secret field is
 * scrubbed via the shared sanitizer before it can reach a log line.
 */

const capturedHttpOptions: { current: any } = { current: null };
const capturedPinoConfig: { current: any } = { current: null };

// Capture the pino-http config so we can exercise customProps directly. The
// underlying pino logger and transport are stubbed so the module initialises
// without spinning up a real log-file transport worker.
vi.mock("pino", () => {
  const fn: any = vi.fn((config: any) => {
    if (config && Array.isArray(config.redact) && !capturedPinoConfig.current) {
      capturedPinoConfig.current = config;
    }
    return {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      child: vi.fn(),
    };
  });
  fn.transport = vi.fn(() => ({ write: vi.fn() }));
  return { default: fn };
});
vi.mock("pino-http", () => ({
  pinoHttp: vi.fn((opts: any) => {
    capturedHttpOptions.current = opts;
    return vi.fn();
  }),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn() };
});
vi.mock("../config-file.js", () => ({
  readConfigFile: vi.fn(() => null),
}));
vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((p: string) => p),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/workcell-test-logs"),
}));

function makeRes(statusCode: number, errorContext?: unknown) {
  const res: any = { statusCode };
  if (errorContext !== undefined) res.__errorContext = errorContext;
  return res;
}

describe("request logger redacts secrets from 4xx/5xx request props", () => {
  // The logger module is a singleton: pinoHttp/pino are invoked exactly once at
  // import time, so capture their config once up front rather than per test.
  beforeAll(async () => {
    await import("../middleware/logger.js");
  });

  it("scrubs secret fields from a raw req.body before logging", () => {
    const opts = capturedHttpOptions.current;
    expect(opts).toBeTruthy();

    const req: any = {
      method: "POST",
      url: "/api/companies/c1/secrets",
      body: {
        name: "OPENAI_API_KEY",
        material: "sk-super-secret-plaintext",
        apiKey: "ghp_secret_value",
        token: "bearer-secret",
        password: "hunter2",
        nested: { secret: "nested-secret-value", safe: "keep-me" },
      },
      params: { companyId: "c1" },
      query: {},
      route: { path: "/companies/:companyId/secrets" },
    };

    const props = opts.customProps(req, makeRes(400)) as any;
    const serialized = JSON.stringify(props);

    // Every plaintext secret must be gone.
    expect(serialized).not.toContain("sk-super-secret-plaintext");
    expect(serialized).not.toContain("ghp_secret_value");
    expect(serialized).not.toContain("bearer-secret");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("nested-secret-value");

    // The structured fields are still present (redacted), and safe values stay.
    expect(props.reqBody.material).toBe(REDACTED_EVENT_VALUE);
    expect(props.reqBody.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(props.reqBody.token).toBe(REDACTED_EVENT_VALUE);
    expect(props.reqBody.password).toBe(REDACTED_EVENT_VALUE);
    expect(props.reqBody.nested.secret).toBe(REDACTED_EVENT_VALUE);
    expect(props.reqBody.nested.safe).toBe("keep-me");
    expect(props.reqBody.name).toBe("OPENAI_API_KEY");
  });

  it("scrubs secrets from a {type:'plain'} env binding body", () => {
    const opts = capturedHttpOptions.current;

    const req: any = {
      method: "POST",
      url: "/api/companies/c1/secret-bindings",
      body: {
        bindings: {
          MY_TOKEN: { type: "plain", value: "plaintext-binding-secret" },
        },
      },
      params: {},
      query: {},
    };

    const props = opts.customProps(req, makeRes(400)) as any;
    expect(JSON.stringify(props)).not.toContain("plaintext-binding-secret");
    expect(props.reqBody.bindings.MY_TOKEN).toEqual({
      type: "plain",
      value: REDACTED_EVENT_VALUE,
    });
  });

  it("scrubs the error-handler-stashed req body (errorContext path)", () => {
    const opts = capturedHttpOptions.current;

    // errorContext as produced by error-handler.ts after our fix already
    // sanitizes, but the logger must also defend in depth in case a raw body
    // is ever stashed. Feed it a raw secret to prove the logger scrubs it.
    const res = makeRes(500, {
      error: { message: "boom" },
      reqBody: { signingSecret: "whsec_raw_secret", bearerToken: "raw-bearer" },
      reqParams: { id: "abc" },
      reqQuery: {},
    });

    const props = opts.customProps({ method: "POST", url: "/x" }, res) as any;
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain("whsec_raw_secret");
    expect(serialized).not.toContain("raw-bearer");
    expect(props.reqBody.signingSecret).toBe(REDACTED_EVENT_VALUE);
    expect(props.reqBody.bearerToken).toBe(REDACTED_EVENT_VALUE);
    expect(props.reqParams.id).toBe("abc");
  });

  it("returns no extra props for successful (2xx) requests", () => {
    const opts = capturedHttpOptions.current;
    const props = opts.customProps(
      { method: "GET", url: "/ok", body: { token: "secret" } },
      makeRes(200),
    );
    expect(props).toEqual({});
  });

  it("registers secret field paths in pino redact config", () => {
    // pino() is called once at import time with the redact config as its first arg.
    const config = capturedPinoConfig.current;
    expect(config).toBeTruthy();
    const redact: string[] = config.redact;
    expect(redact).toContain("req.headers.authorization");
    for (const field of ["material", "secret", "token", "apiKey", "password", "value", "bearerToken", "signingSecret"]) {
      expect(redact.some((p) => p.includes(field))).toBe(true);
    }
  });
});
