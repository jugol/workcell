import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentService } from "../services/agents.ts";

type AgentRow = { id: string; name: string; status: string };

/**
 * Minimal Drizzle stub for agentService.create:
 *  - db.select()...where()  → resolves the company's existing agents (with status)
 *  - db.insert().values().returning() → resolves the freshly-created row
 * The cap check runs off the select() result and throws before insert when over,
 * so the rejection cases never touch the insert path.
 */
function createDb(existingAgents: AgentRow[]) {
  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    then: vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(existingAgents))),
  };

  const insertedRow = {
    id: "agent-new",
    companyId: "company-1",
    name: "New Agent",
    role: "general",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {},
    deliberation: null,
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const returning = vi.fn(() => ({
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([insertedRow])),
  }));
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));

  return {
    db: {
      select: vi.fn(() => selectChain),
      insert,
    },
    insert,
  };
}

function makeLiveAgents(count: number): AgentRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `agent-${index}`,
    name: `Agent ${index}`,
    status: "idle",
  }));
}

describe("per-company agent cap (WORKCELL_MAX_AGENTS_PER_COMPANY)", () => {
  const ENV = "WORKCELL_MAX_AGENTS_PER_COMPANY";
  const original = process.env[ENV];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("rejects creation once the company is at the cap", async () => {
    process.env[ENV] = "2";
    const { db, insert } = createDb(makeLiveAgents(2));
    const svc = agentService(db as never);

    await expect(svc.create("company-1", { name: "New Agent" } as never)).rejects.toMatchObject({
      status: 409,
    });
    // Cap is enforced before the insert.
    expect(insert).not.toHaveBeenCalled();
  });

  it("allows creation when under the cap", async () => {
    process.env[ENV] = "2";
    const { db, insert } = createDb(makeLiveAgents(1));
    const svc = agentService(db as never);

    const created = await svc.create("company-1", { name: "New Agent" } as never);
    expect(created).toMatchObject({ id: "agent-new", companyId: "company-1" });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("does not count terminated agents toward the cap", async () => {
    process.env[ENV] = "2";
    // Two live + many terminated: still under the cap of 2 because terminated don't count.
    const existing: AgentRow[] = [
      { id: "live-1", name: "Live 1", status: "idle" },
      ...Array.from({ length: 10 }, (_unused, index) => ({
        id: `dead-${index}`,
        name: `Dead ${index}`,
        status: "terminated",
      })),
    ];
    const { db, insert } = createDb(existing);
    const svc = agentService(db as never);

    await expect(svc.create("company-1", { name: "New Agent" } as never)).resolves.toMatchObject({
      id: "agent-new",
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("treats WORKCELL_MAX_AGENTS_PER_COMPANY=0 as unlimited", async () => {
    process.env[ENV] = "0";
    const { db, insert } = createDb(makeLiveAgents(50));
    const svc = agentService(db as never);

    await expect(svc.create("company-1", { name: "New Agent" } as never)).resolves.toMatchObject({
      id: "agent-new",
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("defaults to a generous cap of 500 when the env is unset", async () => {
    delete process.env[ENV];
    // 499 live agents is under the default 500 cap → still allowed.
    const { db, insert } = createDb(makeLiveAgents(499));
    const svc = agentService(db as never);

    await expect(svc.create("company-1", { name: "New Agent" } as never)).resolves.toMatchObject({
      id: "agent-new",
    });
    expect(insert).toHaveBeenCalledTimes(1);

    // At the default cap of 500 → rejected.
    const atCap = createDb(makeLiveAgents(500));
    const svcAtCap = agentService(atCap.db as never);
    await expect(svcAtCap.create("company-1", { name: "New Agent" } as never)).rejects.toMatchObject({
      status: 409,
    });
    expect(atCap.insert).not.toHaveBeenCalled();
  });
});
