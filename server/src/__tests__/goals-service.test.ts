import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, goals } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { goalService } from "../services/goals.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping goals service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// WC-162: goalService.create/update did a bare insert/update. parent_id (→ goals.id)
// and owner_agent_id (→ agents.id) are hard FKs with no onDelete, but the route schema
// validates uuid FORMAT only — so a nonexistent id used to hit Postgres 23503 → 500.
// These assert a clean 404 instead, and that valid references still succeed.
describeEmbeddedPostgres("WC-162: goal FK existence validation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-goals-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.update(goals).set({ parentId: null }); // break self-refs before delete
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("rejects create with a nonexistent parentId (404, not 23503/500)", async () => {
    const companyId = await seedCompany();
    await expect(
      goalService(db).create(companyId, { title: "Q3", parentId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    const rows = await db.select().from(goals).where(eq(goals.companyId, companyId));
    expect(rows).toHaveLength(0);
  });

  it("rejects create with a nonexistent ownerAgentId (404, not 23503/500)", async () => {
    const companyId = await seedCompany();
    await expect(
      goalService(db).create(companyId, { title: "Q3", ownerAgentId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("creates a goal with a valid parent and owner agent", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const parent = await goalService(db).create(companyId, { title: "Parent", level: "company" });
    const child = await goalService(db).create(companyId, {
      title: "Child",
      parentId: parent!.id,
      ownerAgentId: agentId,
    });
    expect(child?.parentId).toBe(parent!.id);
    expect(child?.ownerAgentId).toBe(agentId);
  });

  it("rejects an update that sets a nonexistent parentId (404)", async () => {
    const companyId = await seedCompany();
    const goal = await goalService(db).create(companyId, { title: "G" });
    await expect(
      goalService(db).update(goal!.id, { parentId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
