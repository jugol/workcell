import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentMemoryEdges,
  agentMemoryNodes,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent-memory cascade tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// WC-181 (slice 1): the per-agent memory graph rides entirely on DB-level
// ON DELETE CASCADE (migration 0109). These tests prove the cascade design from
// docs/solutions/delete-path-fk-completeness.md: agent / company delete remove
// the memory rows atomically (closing the FK-race class — no purge step in
// agentService.remove() is needed), and deleting a node cascades its edges.
describeEmbeddedPostgres("agent memory cascade", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-agent-memory-cascade-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentMemoryEdges);
    await db.delete(agentMemoryNodes);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: {},
    });
    return { companyId, agentId, runId };
  }

  async function seedMemoryGraph(companyId: string, agentId: string, sourceRunId?: string) {
    const nodeA = randomUUID();
    const nodeB = randomUUID();
    await db.insert(agentMemoryNodes).values([
      {
        id: nodeA,
        companyId,
        agentId,
        kind: "fact",
        label: "deploy-target",
        content: "Prod deploys go to us-east-1.",
        sourceRunId: sourceRunId ?? null,
      },
      {
        id: nodeB,
        companyId,
        agentId,
        kind: "preference",
        label: "tone",
        content: "User prefers terse replies.",
      },
    ]);
    await db.insert(agentMemoryEdges).values({
      id: randomUUID(),
      companyId,
      agentId,
      fromNodeId: nodeA,
      toNodeId: nodeB,
      relation: "relates_to",
    });
    return { nodeA, nodeB };
  }

  it("deleting the AGENT cascades its memory nodes + edges away", async () => {
    const { companyId, agentId, runId } = await seedFixture();
    await seedMemoryGraph(companyId, agentId, runId);

    // Sanity: rows exist before the delete.
    await expect(
      db.select().from(agentMemoryNodes).where(eq(agentMemoryNodes.agentId, agentId)),
    ).resolves.toHaveLength(2);
    await expect(
      db.select().from(agentMemoryEdges).where(eq(agentMemoryEdges.agentId, agentId)),
    ).resolves.toHaveLength(1);

    // agentService.remove() does NOT purge agent_memory explicitly — the
    // company_id/agent_id cascades (migration 0109) remove them atomically with
    // the agent delete. This must NOT 23503 even with memory rows present.
    const removed = await agentService(db).remove(agentId);
    expect(removed?.id).toBe(agentId);

    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(agentMemoryNodes).where(eq(agentMemoryNodes.agentId, agentId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(agentMemoryEdges).where(eq(agentMemoryEdges.agentId, agentId)),
    ).resolves.toHaveLength(0);
  });

  it("deleting the COMPANY cascades its memory nodes + edges away", async () => {
    const { companyId, agentId } = await seedFixture();
    await seedMemoryGraph(companyId, agentId);

    const removed = await companyService(db).remove(companyId);
    expect(removed?.id).toBe(companyId);

    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(agentMemoryNodes).where(eq(agentMemoryNodes.companyId, companyId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(agentMemoryEdges).where(eq(agentMemoryEdges.companyId, companyId)),
    ).resolves.toHaveLength(0);
  });

  it("deleting a memory NODE cascades its incident edges", async () => {
    const { companyId, agentId } = await seedFixture();
    const { nodeA, nodeB } = await seedMemoryGraph(companyId, agentId);

    // Delete one endpoint node directly; the edge between A and B must vanish.
    await db.delete(agentMemoryNodes).where(eq(agentMemoryNodes.id, nodeA));

    await expect(
      db.select().from(agentMemoryNodes).where(eq(agentMemoryNodes.id, nodeA)),
    ).resolves.toHaveLength(0);
    // The surviving node is untouched.
    await expect(
      db.select().from(agentMemoryNodes).where(eq(agentMemoryNodes.id, nodeB)),
    ).resolves.toHaveLength(1);
    // The edge cascaded away with its from-node.
    await expect(
      db.select().from(agentMemoryEdges).where(eq(agentMemoryEdges.agentId, agentId)),
    ).resolves.toHaveLength(0);
  });

  it("deleting the source run NULLs sourceRunId (provenance pointer), memory survives", async () => {
    const { companyId, agentId, runId } = await seedFixture();
    const { nodeA } = await seedMemoryGraph(companyId, agentId, runId);

    // source_run_id is ON DELETE SET NULL — the remembered fact outlives its
    // ephemeral provenance run (WC-174 discipline), only the pointer drops.
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));

    const node = await db
      .select()
      .from(agentMemoryNodes)
      .where(eq(agentMemoryNodes.id, nodeA))
      .then((rows) => rows[0]);
    expect(node).toBeDefined();
    expect(node?.sourceRunId).toBeNull();
    expect(node?.content).toBe("Prod deploys go to us-east-1.");
  });
});
