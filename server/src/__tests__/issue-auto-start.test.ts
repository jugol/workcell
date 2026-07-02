import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  autoStartIssueForPairRound,
  autoStartScopedIssue,
} from "../services/issue-auto-start.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue auto-start embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue auto-start (system todo→in_progress transition)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let otherAgentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-issue-auto-start-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: ("WC" + companyId.replace(/-/g, "").slice(0, 6)).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    agentId = randomUUID();
    otherAgentId = randomUUID();
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Runner", role: "engineer", status: "idle", adapter: "claude_local" },
      { id: otherAgentId, companyId, name: "Other", role: "engineer", status: "idle", adapter: "claude_local" },
    ]);
  });

  afterEach(async () => {
    await db.execute(
      "truncate table companies, agents, issues, heartbeat_runs, activity_log restart identity cascade" as any,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(input: {
    status: string;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Scoped work",
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
    });
    return id;
  }

  async function seedRun(input: {
    agentId: string;
    contextSnapshot: Record<string, unknown> | null;
  }) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: input.agentId,
        status: "running",
        contextSnapshot: input.contextSnapshot ?? undefined,
      })
      .returning();
    return run;
  }

  async function getIssueStatus(issueId: string): Promise<string | null> {
    const rows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    return rows[0]?.status ?? null;
  }

  async function listStatusChangedActivity(issueId: string) {
    return db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.status_changed"),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
        ),
      );
  }

  describe("autoStartScopedIssue (run claim, [B])", () => {
    it("flips a todo issue assigned to the run's agent to in_progress and logs issue.status_changed", async () => {
      const issueId = await seedIssue({ status: "todo", assigneeAgentId: agentId });
      const run = await seedRun({ agentId, contextSnapshot: { issueId } });

      const result = await autoStartScopedIssue(db, run);
      expect(result).toEqual({ issueId });
      expect(await getIssueStatus(issueId)).toBe("in_progress");

      const rows = await listStatusChangedActivity(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0].actorType).toBe("system");
      expect(rows[0].agentId).toBe(agentId);
      expect(rows[0].runId).toBe(run.id);
      expect(rows[0].details).toMatchObject({
        from: "todo",
        to: "in_progress",
        autoStarted: "run_claim",
        runId: run.id,
      });

      // Idempotent: a second call is a no-op (no double transition / log).
      expect(await autoStartScopedIssue(db, run)).toBeNull();
      expect(await listStatusChangedActivity(issueId)).toHaveLength(1);
    });

    it("leaves an issue assigned to a DIFFERENT agent untouched", async () => {
      const issueId = await seedIssue({ status: "todo", assigneeAgentId: otherAgentId });
      const run = await seedRun({ agentId, contextSnapshot: { issueId } });

      expect(await autoStartScopedIssue(db, run)).toBeNull();
      expect(await getIssueStatus(issueId)).toBe("todo");
      expect(await listStatusChangedActivity(issueId)).toHaveLength(0);
    });

    it("does not touch anything for a run without a scoped issueId", async () => {
      const issueId = await seedIssue({ status: "todo", assigneeAgentId: agentId });
      const run = await seedRun({ agentId, contextSnapshot: { wakeReason: "cron" } });

      expect(await autoStartScopedIssue(db, run)).toBeNull();
      expect(await getIssueStatus(issueId)).toBe("todo");
      expect(await listStatusChangedActivity(issueId)).toHaveLength(0);

      const nullContextRun = await seedRun({ agentId, contextSnapshot: null });
      expect(await autoStartScopedIssue(db, nullContextRun)).toBeNull();
      expect(await getIssueStatus(issueId)).toBe("todo");
    });

    it("skips when a human co-assignee is present (assigneeUserId set)", async () => {
      const issueId = await seedIssue({
        status: "todo",
        assigneeAgentId: agentId,
        assigneeUserId: "human-user",
      });
      const run = await seedRun({ agentId, contextSnapshot: { issueId } });

      expect(await autoStartScopedIssue(db, run)).toBeNull();
      expect(await getIssueStatus(issueId)).toBe("todo");
      expect(await listStatusChangedActivity(issueId)).toHaveLength(0);
    });

    it("skips backlog and non-todo statuses (run claim only pulls explicit todo work)", async () => {
      for (const status of ["backlog", "in_progress", "in_review", "done"]) {
        const issueId = await seedIssue({ status, assigneeAgentId: agentId });
        const run = await seedRun({ agentId, contextSnapshot: { issueId } });
        expect(await autoStartScopedIssue(db, run)).toBeNull();
        expect(await getIssueStatus(issueId)).toBe(status);
        expect(await listStatusChangedActivity(issueId)).toHaveLength(0);
      }
    });
  });

  describe("autoStartIssueForPairRound ([A])", () => {
    it("flips backlog AND todo to in_progress with from recorded; leaves other statuses alone", async () => {
      for (const status of ["backlog", "todo"]) {
        const issueId = await seedIssue({ status });
        const result = await autoStartIssueForPairRound(db, {
          companyId,
          issueId,
          pairGroupId: randomUUID(),
          ownerAgentId: agentId,
        });
        expect(result).toEqual({ issueId, from: status });
        expect(await getIssueStatus(issueId)).toBe("in_progress");
        const rows = await listStatusChangedActivity(issueId);
        expect(rows).toHaveLength(1);
        expect(rows[0].details).toMatchObject({
          from: status,
          to: "in_progress",
          autoStarted: "pair_round",
        });
      }

      for (const status of ["in_progress", "in_review", "done", "cancelled"]) {
        const issueId = await seedIssue({ status });
        expect(
          await autoStartIssueForPairRound(db, {
            companyId,
            issueId,
            pairGroupId: randomUUID(),
            ownerAgentId: agentId,
          }),
        ).toBeNull();
        expect(await getIssueStatus(issueId)).toBe(status);
        expect(await listStatusChangedActivity(issueId)).toHaveLength(0);
      }
    });

    it("returns null for a missing issue without throwing", async () => {
      expect(
        await autoStartIssueForPairRound(db, {
          companyId,
          issueId: randomUUID(),
          pairGroupId: randomUUID(),
          ownerAgentId: null,
        }),
      ).toBeNull();
    });
  });
});
