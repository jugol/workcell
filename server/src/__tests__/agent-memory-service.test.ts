import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentMemoryEdges,
  agentMemoryNodes,
  agents,
  companies,
  createDb,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentMemoryService } from "../services/agent-memory.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent-memory service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// WC-181 (slice 1): agentMemoryService behavior — idempotent upsert, graph
// read, scoped deletes, and the load-bearing tenant+agent isolation invariant.
describeEmbeddedPostgres("agent memory service", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentMemoryService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-agent-memory-service-");
    db = createDb(tempDb.connectionString);
    svc = agentMemoryService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentMemoryEdges);
    await db.delete(agentMemoryNodes);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithAgents() {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentA,
        companyId,
        name: "AgentA",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentB,
        companyId,
        name: "AgentB",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, agentA, agentB };
  }

  it("upsertNode is idempotent on (company, agent, kind, label) and updates in place", async () => {
    const { companyId, agentA } = await seedCompanyWithAgents();

    const first = await svc.upsertNode({
      companyId,
      agentId: agentA,
      kind: "fact",
      label: "deploy-target",
      content: "us-east-1",
      metadata: { confidence: 0.5 },
    });
    expect(first.content).toBe("us-east-1");

    // Same (kind, label) → updates the SAME row, no duplicate.
    const second = await svc.upsertNode({
      companyId,
      agentId: agentA,
      kind: "fact",
      label: "deploy-target",
      content: "us-west-2",
      metadata: { confidence: 0.9 },
    });
    expect(second.id).toBe(first.id);
    expect(second.content).toBe("us-west-2");
    expect(second.metadata).toEqual({ confidence: 0.9 });

    const all = await db
      .select()
      .from(agentMemoryNodes)
      .where(eq(agentMemoryNodes.agentId, agentA));
    expect(all).toHaveLength(1);
  });

  it("upsertNode preserves existing metadata/sourceRunId when not provided on re-upsert", async () => {
    const { companyId, agentA } = await seedCompanyWithAgents();
    const created = await svc.upsertNode({
      companyId,
      agentId: agentA,
      kind: "preference",
      label: "tone",
      content: "terse",
      metadata: { source: "onboarding" },
    });
    expect(created.metadata).toEqual({ source: "onboarding" });

    // Re-upsert without metadata: content refreshes, metadata is preserved.
    const updated = await svc.upsertNode({
      companyId,
      agentId: agentA,
      kind: "preference",
      label: "tone",
      content: "very terse",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.content).toBe("very terse");
    expect(updated.metadata).toEqual({ source: "onboarding" });
  });

  it("rejects an invalid node kind at the service layer", async () => {
    const { companyId, agentA } = await seedCompanyWithAgents();
    await expect(
      svc.upsertNode({
        companyId,
        agentId: agentA,
        // @ts-expect-error — deliberately invalid open-enum value
        kind: "bogus",
        label: "x",
        content: "y",
      }),
    ).rejects.toThrow(/Invalid agent memory node kind/);
  });

  it("createEdge is idempotent on (from, to, relation) and listGraph returns the graph", async () => {
    const { companyId, agentA } = await seedCompanyWithAgents();
    const a = await svc.upsertNode({ companyId, agentId: agentA, kind: "fact", label: "a", content: "A" });
    const b = await svc.upsertNode({ companyId, agentId: agentA, kind: "entity", label: "b", content: "B" });

    const edge1 = await svc.createEdge({
      companyId,
      agentId: agentA,
      fromNodeId: a.id,
      toNodeId: b.id,
      relation: "relates_to",
    });
    const edge2 = await svc.createEdge({
      companyId,
      agentId: agentA,
      fromNodeId: a.id,
      toNodeId: b.id,
      relation: "relates_to",
    });
    expect(edge2?.id).toBe(edge1?.id);

    const graph = await svc.listGraph(companyId, agentA);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
  });

  it("deleteNode removes the node (and cascades its edges); deleteEdge removes an edge", async () => {
    const { companyId, agentA } = await seedCompanyWithAgents();
    const a = await svc.upsertNode({ companyId, agentId: agentA, kind: "fact", label: "a", content: "A" });
    const b = await svc.upsertNode({ companyId, agentId: agentA, kind: "fact", label: "b", content: "B" });
    const edge = await svc.createEdge({
      companyId,
      agentId: agentA,
      fromNodeId: a.id,
      toNodeId: b.id,
      relation: "relates_to",
    });

    // deleteEdge: scoped removal of just the edge.
    const removedEdge = await svc.deleteEdge(companyId, agentA, edge!.id);
    expect(removedEdge?.id).toBe(edge!.id);
    expect((await svc.listGraph(companyId, agentA)).edges).toHaveLength(0);

    // Re-link, then deleteNode the from-node → edge cascades.
    const edge2 = await svc.createEdge({
      companyId,
      agentId: agentA,
      fromNodeId: a.id,
      toNodeId: b.id,
      relation: "relates_to",
    });
    expect(edge2).toBeDefined();
    const removedNode = await svc.deleteNode(companyId, agentA, a.id);
    expect(removedNode?.id).toBe(a.id);
    const graph = await svc.listGraph(companyId, agentA);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  it("isolation: agentA cannot see, upsert-collide, or delete agentB's nodes", async () => {
    const { companyId, agentA, agentB } = await seedCompanyWithAgents();

    // Same (kind, label) for both agents — the unique index is agent-scoped, so
    // these are two DISTINCT rows, not a collision.
    const aNode = await svc.upsertNode({
      companyId,
      agentId: agentA,
      kind: "fact",
      label: "shared-label",
      content: "A's memory",
    });
    const bNode = await svc.upsertNode({
      companyId,
      agentId: agentB,
      kind: "fact",
      label: "shared-label",
      content: "B's memory",
    });
    expect(aNode.id).not.toBe(bNode.id);

    // listGraph is agent-scoped: A sees only A's node, B only B's.
    const aGraph = await svc.listGraph(companyId, agentA);
    expect(aGraph.nodes).toHaveLength(1);
    expect(aGraph.nodes[0].content).toBe("A's memory");
    const bGraph = await svc.listGraph(companyId, agentB);
    expect(bGraph.nodes).toHaveLength(1);
    expect(bGraph.nodes[0].content).toBe("B's memory");

    // A cannot delete B's node via A's scope — returns null, B's node survives.
    const crossDelete = await svc.deleteNode(companyId, agentA, bNode.id);
    expect(crossDelete).toBeNull();
    await expect(
      db.select().from(agentMemoryNodes).where(eq(agentMemoryNodes.id, bNode.id)),
    ).resolves.toHaveLength(1);

    // getNode is likewise scoped: A cannot read B's node.
    expect(await svc.getNode(companyId, agentA, bNode.id)).toBeNull();
    expect((await svc.getNode(companyId, agentB, bNode.id))?.id).toBe(bNode.id);
  });
});
