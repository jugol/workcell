import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  budgetPolicies,
  companies,
  companySkills,
  costEvents,
  createDb,
  documents,
  documentRevisions,
  feedbackVotes,
  financeEvents,
  goals,
  graphEdges,
  graphNodes,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueInboxArchives,
  issueReadStates,
  issueThreadInteractions,
  issues,
  pairGroups,
  projects,
  routines,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.ts";
import { goalService } from "../services/goals.ts";
import { issueService } from "../services/issues.ts";
import { projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cleanup removal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cleanup removal services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-cleanup-removal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.execute("truncate table activity_log restart identity cascade" as any);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(companySkills);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
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

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Regression fixture",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    return { agentId, companyId, issueId, runId };
  }

  it("removes agent-owned issue comments and run-linked activity before deleting the agent", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Agent-authored comment",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "heartbeat.completed",
      entityType: "issue",
      entityId: issueId,
      runId,
      details: {},
    });

    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      actorAgentId: agentId,
      outcome: "approved",
      body: "Looks good",
      createdByRunId: runId,
    });

    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("WC-124/137: removes an agent w/ cross-actor run events; PRESERVES (nulls) its cost/finance billing", async () => {
    const { agentId, companyId, runId } = await seedFixture();

    // A second agent acts within agent A's run (e.g. a pair counterpart), so the
    // run event's agentId is NOT the run owner — agentId-only deletion misses it.
    const counterpartId = randomUUID();
    await db.insert(agents).values({
      id: counterpartId,
      companyId,
      name: "Counterpart",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId: counterpartId, // cross-actor: belongs to A's run, attributed to B
      seq: 1,
      eventType: "output",
      message: "cross-actor event in agent A's run",
    });

    // Agent A's own billing history, linked to its run. WC-137: this must SURVIVE
    // the agent delete (agentId + heartbeatRunId SET NULL), not be purged — a
    // company's spend history cannot vanish when an agent is removed.
    const costEventId = randomUUID();
    const financeEventId = randomUUID();
    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      heartbeatRunId: runId,
      provider: "codex",
      model: "gpt-5-codex",
      costCents: 12,
      occurredAt: new Date(),
    });
    await db.insert(financeEvents).values({
      id: financeEventId,
      companyId,
      agentId,
      heartbeatRunId: runId,
      eventKind: "usage",
      biller: "openai",
      amountCents: 12,
      occurredAt: new Date(),
    });

    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)),
    ).resolves.toHaveLength(0);
    // WC-137: billing is PRESERVED (not purged) — the company's spend history
    // must survive agent delete. The cost/finance rows remain with agentId +
    // heartbeatRunId SET NULL and company_id + cents intact (company total stable).
    const survivingCost = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.id, costEventId))
      .then((rows) => rows[0]);
    expect(survivingCost).toBeDefined();
    expect(survivingCost?.agentId).toBeNull();
    expect(survivingCost?.heartbeatRunId).toBeNull();
    expect(survivingCost?.companyId).toBe(companyId);
    expect(survivingCost?.costCents).toBe(12);
    const survivingFinance = await db
      .select()
      .from(financeEvents)
      .where(eq(financeEvents.id, financeEventId))
      .then((rows) => rows[0]);
    expect(survivingFinance).toBeDefined();
    expect(survivingFinance?.agentId).toBeNull();
    expect(survivingFinance?.heartbeatRunId).toBeNull();
    expect(survivingFinance?.companyId).toBe(companyId);
    expect(survivingFinance?.amountCents).toBe(12);
    // The counterpart agent is untouched.
    await expect(db.select().from(agents).where(eq(agents.id, counterpartId))).resolves.toHaveLength(1);
  });

  it("WC-171: deleting a heartbeat run cascades its run events (closes the agent-removal race)", async () => {
    const { agentId, companyId, runId } = await seedFixture();
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "log",
      message: "streamed during the run",
    });

    // ON DELETE CASCADE (migration 0106): deleting the run removes its events
    // atomically instead of throwing an FK violation. This is what lets the live
    // run executor write events concurrently with agentService.remove() without
    // the run delete failing and rolling back the whole agent deletion.
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await expect(
      db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)),
    ).resolves.toHaveLength(0);
  });

  it("WC-174: deleting a heartbeat run nulls activity_log.run_id (audit preserved, no FK block)", async () => {
    const { agentId, companyId, runId } = await seedFixture();
    const logId = randomUUID();
    await db.insert(activityLog).values({
      id: logId,
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId,
      action: "heartbeat.run.event",
      entityType: "issue",
      entityId: randomUUID(),
      details: { streamed: true },
    });

    // ON DELETE SET NULL (migration 0107): the run delete nulls run_id — and the
    // append-only trigger ALLOWS this specific FK-driven null-ing UPDATE — instead
    // of FK-blocking. The audit row survives with the dead pointer dropped. This is
    // what lets the live executor write activity concurrently with agent removal.
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const row = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.id, logId))
      .then((r) => r[0]);
    expect(row).toBeDefined();
    expect(row.runId).toBeNull();
    expect(row.agentId).toBe(agentId);
    expect(row.action).toBe("heartbeat.run.event");
  });

  it("WC-141: removes an agent referenced by project.leadAgentId / goal.ownerAgentId (FK detach, no 500)", async () => {
    const { agentId, companyId } = await seedFixture();
    const projectId = randomUUID();
    const goalId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Proj", leadAgentId: agentId });
    await db.insert(goals).values({ id: goalId, companyId, title: "Goal", ownerAgentId: agentId });

    // Without WC-141 these no-onDelete agent FKs make delete(agents) throw → 500.
    const removed = await agentService(db).remove(agentId);
    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);

    // Parent records SURVIVE with the agent link detached (nulled), not deleted.
    const proj = await db.select().from(projects).where(eq(projects.id, projectId)).then((r) => r[0]);
    expect(proj).toBeDefined();
    expect(proj?.leadAgentId ?? null).toBeNull();
    const goal = await db.select().from(goals).where(eq(goals.id, goalId)).then((r) => r[0]);
    expect(goal).toBeDefined();
    expect(goal?.ownerAgentId ?? null).toBeNull();
  });

  it("WC-158: deleting an agent pauses its active routines (no zombie scheduler ticks)", async () => {
    const { agentId, companyId } = await seedFixture();
    const activeRoutineId = randomUUID();
    const draftRoutineId = randomUUID();
    // An ACTIVE routine requires a default agent. A DRAFT routine assigned to the
    // same agent is the control: only active routines demote, draft keeps its status.
    await db.insert(routines).values([
      { id: activeRoutineId, companyId, title: "Nightly digest", assigneeAgentId: agentId, status: "active" },
      { id: draftRoutineId, companyId, title: "Draft idea", assigneeAgentId: agentId, status: "draft" },
    ]);

    const removed = await agentService(db).remove(agentId);
    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);

    // The active routine survives but is detached AND demoted to "paused" so the
    // scheduler stops selecting it (it would otherwise fail "Default agent required"
    // every tick). The draft routine is detached but keeps its status.
    const active = await db.select().from(routines).where(eq(routines.id, activeRoutineId)).then((r) => r[0]);
    expect(active).toBeDefined();
    expect(active?.assigneeAgentId ?? null).toBeNull();
    expect(active?.status).toBe("paused");
    const draft = await db.select().from(routines).where(eq(routines.id, draftRoutineId)).then((r) => r[0]);
    expect(draft).toBeDefined();
    expect(draft?.assigneeAgentId ?? null).toBeNull();
    expect(draft?.status).toBe("draft");
  });

  it("WC-159: issueService.remove() detaches child issues (parentId self-FK, no 500)", async () => {
    const { companyId, issueId } = await seedFixture();
    // issueId is the PARENT. issues.parentId is a self-FK with NO onDelete, so
    // deleting the parent while a child still points at it FK-violates (500).
    const childIssueId = randomUUID();
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      title: "Child task",
      status: "todo",
      priority: "medium",
      parentId: issueId,
      createdByUserId: "user-1",
    });

    const removed = await issueService(db).remove(issueId);
    expect(removed?.id).toBe(issueId);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);

    // The child issue SURVIVES, detached to top-level (parentId nulled).
    const child = await db.select().from(issues).where(eq(issues.id, childIssueId)).then((r) => r[0]);
    expect(child).toBeDefined();
    expect(child?.parentId ?? null).toBeNull();
  });

  it("WC-159: companyService.remove() purges agent-assigned routines (no 500 on company delete)", async () => {
    const { agentId, companyId } = await seedFixture();
    // routines.assigneeAgentId -> agents.id is no-onDelete; companyService.remove
    // deletes agents directly (bypassing agentService.remove's WC-158 detach), so an
    // agent-assigned routine would FK-violate (500) when tx.delete(agents) runs.
    const routineId = randomUUID();
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Nightly digest",
      assigneeAgentId: agentId,
      status: "active",
    });

    const removed = await companyService(db).remove(companyId);
    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    // The routine is gone (the whole company is deleted), and no FK violation occurred.
    await expect(db.select().from(routines).where(eq(routines.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("WC-134: issueService.remove() deletes an issue that has non-cascading children", async () => {
    const { agentId, companyId, issueId } = await seedFixture();
    // issue_comments + issue_read_states reference issues.id with NO onDelete —
    // delete(issues) would FK-violate (500) unless they are pre-deleted. Any
    // worked issue has these, so issue hard-delete was broadly broken.
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "a comment",
    });
    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    const removed = await issueService(db).remove(issueId);

    expect(removed?.id).toBe(issueId);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueComments).where(eq(issueComments.issueId, issueId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueReadStates).where(eq(issueReadStates.issueId, issueId)),
    ).resolves.toHaveLength(0);
  });

  it("WC-134: issueService.remove() preserves cost/finance history (nulls the issue link)", async () => {
    const { agentId, companyId, issueId } = await seedFixture();
    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId,
      provider: "codex",
      model: "gpt-5",
      costCents: 7,
      occurredAt: new Date(),
    });

    await issueService(db).remove(issueId);

    // The cost event survives (company billing history) with its issue link nulled.
    const costs = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(costs).toHaveLength(1);
    expect(costs[0].issueId).toBeNull();
  });

  it("WC-135: projectService.remove() orphans its issues + preserves cost/finance (non-cascading FK)", async () => {
    const { agentId, companyId, issueId } = await seedFixture();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Repo project" });
    await db.update(issues).set({ projectId }).where(eq(issues.id, issueId));
    await db.insert(costEvents).values({
      companyId,
      agentId,
      projectId,
      provider: "codex",
      model: "gpt-5",
      costCents: 9,
      occurredAt: new Date(),
    });

    const removed = await projectService(db).remove(projectId);

    expect(removed?.id).toBe(projectId);
    await expect(db.select().from(projects).where(eq(projects.id, projectId))).resolves.toHaveLength(0);
    // The issue survives (top-level entity), orphaned from the deleted project.
    const [iss] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(iss.projectId).toBeNull();
    // Cost history survives with its project link nulled.
    const costs = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(costs[0].projectId).toBeNull();
  });

  it("WC-135: goalService.remove() detaches its issues/projects + preserves cost (non-cascading FK)", async () => {
    const { agentId, companyId, issueId } = await seedFixture();
    const goalId = randomUUID();
    const projectId = randomUUID();
    await db.insert(goals).values({ id: goalId, companyId, title: "Q3 goal" });
    await db.insert(projects).values({ id: projectId, companyId, name: "P", goalId });
    await db.update(issues).set({ goalId }).where(eq(issues.id, issueId));
    await db.insert(costEvents).values({
      companyId,
      agentId,
      goalId,
      provider: "codex",
      model: "gpt-5",
      costCents: 4,
      occurredAt: new Date(),
    });

    const removed = await goalService(db).remove(goalId);

    expect(removed?.id).toBe(goalId);
    await expect(db.select().from(goals).where(eq(goals.id, goalId))).resolves.toHaveLength(0);
    const [iss] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(iss.goalId).toBeNull();
    const [proj] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(proj.goalId).toBeNull();
    const costs = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(costs[0].goalId).toBeNull();
  });

  it("removes issue read states and activity rows before deleting the company", async () => {
    const { companyId, issueId, runId } = await seedFixture();
    const documentId = randomUUID();
    const revisionId = randomUUID();

    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: "workcell/workcell/workcell",
      slug: "workcell",
      name: "Workcell",
      markdown: "# Workcell",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "system",
      actorId: "system",
      action: "run.created",
      entityType: "run",
      entityId: runId,
      runId,
      details: {},
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Run summary",
      latestBody: "body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "user-1",
      updatedByAgentId: null,
      updatedByUserId: "user-1",
    });

    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key: "summary",
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Run summary",
      format: "markdown",
      body: "body",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdByRunId: runId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(documents).where(eq(documents.id, documentId))).resolves.toHaveLength(0);
    await expect(db.select().from(documentRevisions).where(eq(documentRevisions.id, revisionId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("WC-117: removes company-level budget + knowledge-graph rows (bug-hunt Finding 2, partial)", async () => {
    const { companyId } = await seedFixture();
    // Company-level tables with a non-cascade company_id FK and no cascading
    // parent — these used to FK-block the final company delete.
    await db.insert(budgetPolicies).values({
      id: randomUUID(),
      companyId,
      scopeType: "company",
      scopeId: companyId,
      windowKind: "monthly",
      amount: 1000,
    });
    const nodeA = randomUUID();
    const nodeB = randomUUID();
    await db.insert(graphNodes).values([
      { id: nodeA, companyId, nodeKind: "issue", entityRef: "ref-a", label: "A" },
      { id: nodeB, companyId, nodeKind: "code", entityRef: "src/x.ts", label: "B" },
    ]);
    // graph_edges cascade-delete via their graph_nodes FK when the nodes go.
    await db.insert(graphEdges).values({
      id: randomUUID(),
      companyId,
      fromNodeId: nodeA,
      toNodeId: nodeB,
      edgeKind: "references",
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(graphNodes).where(eq(graphNodes.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(graphEdges).where(eq(graphEdges.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("WC-118: removes the remaining issue/agent/company-level orphan tables (Finding 2 complete)", async () => {
    const { companyId, issueId } = await seedFixture();
    // True orphans: non-cascade FK to issues/agents/company, no cascading parent.
    await db.insert(feedbackVotes).values({
      id: randomUUID(),
      companyId,
      issueId,
      targetType: "issue",
      targetId: issueId,
      authorUserId: "user-1",
      vote: "up",
    });
    await db.insert(pairGroups).values({ id: randomUUID(), companyId, issueId });
    await db.insert(issueInboxArchives).values({ id: randomUUID(), companyId, issueId, userId: "user-1" });
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "system_notice",
      payload: {},
    } as typeof issueThreadInteractions.$inferInsert);
    await db.insert(workspaceOperations).values({ id: randomUUID(), companyId, phase: "materialize" });
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId,
      scopeType: "company",
      serviceName: "svc",
      status: "running",
      lifecycle: "ephemeral",
      provider: "docker",
    });
    await db.insert(inboxDismissals).values({ id: randomUUID(), companyId, userId: "user-1", itemKey: "k" });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(pairGroups).where(eq(pairGroups.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(feedbackVotes).where(eq(feedbackVotes.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(inboxDismissals).where(eq(inboxDismissals.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes heartbeat events by run id before deleting company-owned runs", async () => {
    const { agentId, companyId, runId } = await seedFixture();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Company",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(heartbeatRunEvents).values({
      companyId: otherCompanyId,
      runId,
      agentId,
      seq: 1,
      eventType: "output",
      message: "event with mismatched company scope",
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, otherCompanyId))).resolves.toHaveLength(1);
  });
});
