import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

// Mint a token by re-signing hand-built claims with the same secret + HS256 the
// production code uses. This lets us craft tokens that legitimately omit iss/aud
// (or carry a wrong aud) while keeping a VALID signature, so they fail only on
// the iss/aud assertion rather than on a broken signature.
function signClaims(secret: string, claims: Record<string, unknown>) {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("agent local JWT", () => {
  const secretEnv = "WORKCELL_AGENT_JWT_SECRET";
  const betterAuthSecretEnv = "BETTER_AUTH_SECRET";
  const ttlEnv = "WORKCELL_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "WORKCELL_AGENT_JWT_ISSUER";
  const audienceEnv = "WORKCELL_AGENT_JWT_AUDIENCE";

  const originalEnv = {
    secret: process.env[secretEnv],
    betterAuthSecret: process.env[betterAuthSecretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
  };

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    delete process.env[betterAuthSecretEnv];
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.betterAuthSecret === undefined) delete process.env[betterAuthSecretEnv];
    else process.env[betterAuthSecretEnv] = originalEnv.betterAuthSecret;
    if (originalEnv.ttl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalEnv.ttl;
    if (originalEnv.issuer === undefined) delete process.env[issuerEnv];
    else process.env[issuerEnv] = originalEnv.issuer;
    if (originalEnv.audience === undefined) delete process.env[audienceEnv];
    else process.env[audienceEnv] = originalEnv.audience;
  });

  it("creates and verifies a token", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iss: "workcell",
      aud: "workcell-api",
    });
  });

  it("returns null when secret is missing", () => {
    process.env[secretEnv] = "";
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeNull();
    expect(verifyLocalAgentJwt("abc.def.ghi")).toBeNull();
  });

  it("falls back to BETTER_AUTH_SECRET when WORKCELL_AGENT_JWT_SECRET is absent", () => {
    delete process.env[secretEnv];
    process.env[betterAuthSecretEnv] = "fallback-secret";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
    });
  });

  it("rejects expired tokens", () => {
    process.env[ttlEnv] = "1";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("rejects issuer/audience mismatch", () => {
    process.env[issuerEnv] = "custom-issuer";
    process.env[audienceEnv] = "custom-audience";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    process.env[issuerEnv] = "workcell";
    process.env[audienceEnv] = "workcell-api";
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("round-trips a freshly minted token with iss/aud present", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    const claims = verifyLocalAgentJwt(token!);
    expect(claims).not.toBeNull();
    expect(claims!.iss).toBe("workcell");
    expect(claims!.aud).toBe("workcell-api");
  });

  it("rejects a validly-signed token that omits iss", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const now = Math.floor(Date.now() / 1000);
    // Correct secret + signature, but no `iss` claim → must be rejected now.
    const token = signClaims("test-secret", {
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iat: now,
      exp: now + 3600,
      aud: "workcell-api",
    });
    expect(verifyLocalAgentJwt(token)).toBeNull();
  });

  it("rejects a validly-signed token that omits aud", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const now = Math.floor(Date.now() / 1000);
    const token = signClaims("test-secret", {
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iat: now,
      exp: now + 3600,
      iss: "workcell",
    });
    expect(verifyLocalAgentJwt(token)).toBeNull();
  });

  it("rejects a validly-signed token with a wrong aud", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const now = Math.floor(Date.now() / 1000);
    const token = signClaims("test-secret", {
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iat: now,
      exp: now + 3600,
      iss: "workcell",
      aud: "some-other-audience",
    });
    expect(verifyLocalAgentJwt(token)).toBeNull();
  });

  it("accepts a hand-signed token that includes the correct iss/aud", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const now = Math.floor(Date.now() / 1000);
    const token = signClaims("test-secret", {
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iat: now,
      exp: now + 3600,
      iss: "workcell",
      aud: "workcell-api",
    });
    const claims = verifyLocalAgentJwt(token);
    expect(claims).not.toBeNull();
    expect(claims!.iss).toBe("workcell");
    expect(claims!.aud).toBe("workcell-api");
  });
});
