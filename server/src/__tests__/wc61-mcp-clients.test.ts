import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilities, capabilityAssignments, companies, createDb } from "@workcell/db";
import type { McpClientConfig } from "@workcell/mcp-bridge";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  mcpClientRegistry,
  McpNotAuthorizedError,
  McpServerMisconfiguredError,
  McpServerNotFoundError,
  type McpClientLike,
} from "../services/mcp-clients.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-61 mcp-clients embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

// A stateful fake McpClient — no subprocess. Records connect/callTool/disconnect.
function makeFakeClient(opts?: { callThrows?: boolean; callIsError?: boolean }) {
  let connected = false;
  return {
    get isConnected() {
      return connected;
    },
    connect: vi.fn(async () => {
      connected = true;
    }),
    listTools: vi.fn(async () => [{ name: "echo" }]),
    callTool: vi.fn(async (name: string) => {
      if (opts?.callThrows) throw new Error("boom");
      return { text: `ran ${name}`, isError: Boolean(opts?.callIsError), content: [] };
    }),
    disconnect: vi.fn(async () => {
      connected = false;
    }),
  };
}

describeEmbeddedPostgres("WC-61 mcpClientRegistry (capability-gated outbound MCP)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc61-mcp-clients-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    issuePrefix = ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, capabilities, capability_assignments restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Seed an MCP capability (+ optional assignment) for `companyId`.
  async function seedMcpCapability(input: {
    company?: string;
    key: string;
    metadata?: Record<string, unknown>;
    assignmentStatus?: "active" | "pending_approval" | "revoked" | null; // null = no assignment
  }) {
    const cid = input.company ?? companyId;
    const capId = randomUUID();
    await db.insert(capabilities).values({
      id: capId,
      companyId: cid,
      key: input.key,
      name: input.key,
      sourceKind: "mcp",
      metadata: input.metadata ?? { command: "node", args: ["fake-server.mjs"] },
    });
    if (input.assignmentStatus) {
      await db.insert(capabilityAssignments).values({
        companyId: cid,
        capabilityId: capId,
        agentId: null, // company-wide
        status: input.assignmentStatus,
      });
    }
    return capId;
  }

  function registryWithFakes() {
    const created: Array<{ config: McpClientConfig; client: ReturnType<typeof makeFakeClient> }> = [];
    const reg = mcpClientRegistry(db, {
      createClient: (config) => {
        const client = makeFakeClient();
        created.push({ config, client });
        return client as unknown as McpClientLike;
      },
    });
    return { reg, created };
  }

  it("returns a connected client for an active company-wide assignment and caches it", async () => {
    await seedMcpCapability({
      key: "open-design",
      metadata: { command: "node", args: ["od.mjs"], env: { OD_KEY: "x" } },
      assignmentStatus: "active",
    });
    const { reg, created } = registryWithFakes();

    const client = await reg.getClient(companyId, "open-design");
    expect(client.isConnected).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].config).toEqual({
      command: "node",
      args: ["od.mjs"],
      env: { OD_KEY: "x" },
      cwd: undefined,
      timeoutMs: undefined,
      connectTimeoutMs: undefined,
    });
    expect(created[0].client.connect).toHaveBeenCalledTimes(1);

    // Second call reuses the cached singleton (no new client, no reconnect).
    const again = await reg.getClient(companyId, "open-design");
    expect(again).toBe(client);
    expect(created).toHaveLength(1);
    expect(created[0].client.connect).toHaveBeenCalledTimes(1);
  });

  it("throws McpNotAuthorizedError and spawns NOTHING when there is no assignment", async () => {
    await seedMcpCapability({ key: "open-design", assignmentStatus: null });
    const { reg, created } = registryWithFakes();
    await expect(reg.getClient(companyId, "open-design")).rejects.toBeInstanceOf(McpNotAuthorizedError);
    expect(created).toHaveLength(0);
  });

  it("rejects a revoked or pending assignment (only active grants access)", async () => {
    await seedMcpCapability({ key: "revoked-srv", assignmentStatus: "revoked" });
    await seedMcpCapability({ key: "pending-srv", assignmentStatus: "pending_approval" });
    const { reg, created } = registryWithFakes();
    await expect(reg.getClient(companyId, "revoked-srv")).rejects.toBeInstanceOf(McpNotAuthorizedError);
    await expect(reg.getClient(companyId, "pending-srv")).rejects.toBeInstanceOf(McpNotAuthorizedError);
    expect(created).toHaveLength(0);
  });

  it("throws McpServerNotFoundError for an unknown key", async () => {
    const { reg } = registryWithFakes();
    await expect(reg.getClient(companyId, "nope")).rejects.toBeInstanceOf(McpServerNotFoundError);
  });

  it("throws McpServerMisconfiguredError when metadata has no runnable command", async () => {
    await seedMcpCapability({ key: "broken", metadata: { note: "no command here" }, assignmentStatus: "active" });
    const { reg, created } = registryWithFakes();
    await expect(reg.getClient(companyId, "broken")).rejects.toBeInstanceOf(McpServerMisconfiguredError);
    expect(created).toHaveLength(0);
  });

  it("isolates clients per company (same key, different companies)", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: "OTH",
      requireBoardApprovalForNewAgents: false,
    });
    await seedMcpCapability({ key: "shared", assignmentStatus: "active" });
    await seedMcpCapability({ company: otherCompanyId, key: "shared", assignmentStatus: "active" });

    const { reg, created } = registryWithFakes();
    const a = await reg.getClient(companyId, "shared");
    const b = await reg.getClient(otherCompanyId, "shared");
    expect(a).not.toBe(b);
    expect(created).toHaveLength(2);

    await db.execute(
      "truncate table companies, capabilities, capability_assignments restart identity cascade" as any,
    );
  });

  it("disconnect evicts the cache so the next getClient reconnects", async () => {
    await seedMcpCapability({ key: "srv", assignmentStatus: "active" });
    const { reg, created } = registryWithFakes();

    const first = await reg.getClient(companyId, "srv");
    await reg.disconnect(companyId, "srv");
    expect(first.isConnected).toBe(false);
    expect((created[0].client.disconnect as any)).toHaveBeenCalledTimes(1);

    const second = await reg.getClient(companyId, "srv");
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });

  it("SECURITY: re-checks authorization on every getClient — revocation takes effect immediately", async () => {
    const capId = await seedMcpCapability({ key: "srv", assignmentStatus: "active" });
    const { reg } = registryWithFakes();

    // First call authorized.
    const client = await reg.getClient(companyId, "srv");
    expect(client.isConnected).toBe(true);

    // Revoke the company-wide assignment.
    await db
      .update(capabilityAssignments)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eqCap(capId));

    // The very next getClient must re-gate and refuse — even though a
    // connected client is cached.
    await expect(reg.getClient(companyId, "srv")).rejects.toBeInstanceOf(McpNotAuthorizedError);
  });

  it("telemetry counts calls + failures (thrown error and isError result both fail)", async () => {
    await seedMcpCapability({ key: "ok", assignmentStatus: "active" });
    await seedMcpCapability({ key: "throws", assignmentStatus: "active" });
    await seedMcpCapability({ key: "errResult", assignmentStatus: "active" });

    // Custom registry whose fake clients vary per key.
    const reg = mcpClientRegistry(db, {
      createClient: (config) => {
        const throws = config.args?.[0] === "throws";
        const isErr = config.args?.[0] === "errResult";
        return makeFakeClient({ callThrows: throws, callIsError: isErr }) as unknown as McpClientLike;
      },
    });
    // seedMcpCapability default metadata args=["fake-server.mjs"]; override per key
    // by re-seeding with discriminating args.
    await db.update(capabilities).set({ metadata: { command: "node", args: ["throws"] } }).where(eqKey("throws"));
    await db.update(capabilities).set({ metadata: { command: "node", args: ["errResult"] } }).where(eqKey("errResult"));

    const okRes = await reg.callTool(companyId, "ok", "echo", {});
    expect(okRes.isError).toBe(false);
    expect(reg.getTelemetry(companyId, "ok")).toMatchObject({ calls: 1, failures: 0 });

    await expect(reg.callTool(companyId, "throws", "echo", {})).rejects.toThrow();
    expect(reg.getTelemetry(companyId, "throws")).toMatchObject({ calls: 1, failures: 1 });

    const errRes = await reg.callTool(companyId, "errResult", "echo", {});
    expect(errRes.isError).toBe(true);
    expect(reg.getTelemetry(companyId, "errResult")).toMatchObject({ calls: 1, failures: 1, lastErrorCode: "tool_error" });
  });

  // --- tiny local query helpers ---
  function eqCap(capId: string) {
    return and(
      eq(capabilityAssignments.companyId, companyId),
      eq(capabilityAssignments.capabilityId, capId),
      isNull(capabilityAssignments.agentId),
    );
  }
  function eqKey(key: string) {
    return and(eq(capabilities.companyId, companyId), eq(capabilities.key, key));
  }
});
