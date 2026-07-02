import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@workcell/db";
import { agents, goals, issues, projects, costEvents, financeEvents } from "@workcell/db";
import { assertBelongsToCompany } from "./finance.js";

type GoalReader = Pick<Db, "select">;

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function goalService(db: Db) {
  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: async (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) => {
      // WC-162: parent_id (→ goals.id) and owner_agent_id (→ agents.id) are hard FKs
      // with no onDelete; the route schema validates uuid FORMAT only, so a nonexistent
      // id would 23503 → 500. Validate existence + company first (404/422), mirroring
      // assertParentIssueInCompany on the issue path.
      if (data.parentId) await assertBelongsToCompany(db, goals, data.parentId, companyId, "Parent goal");
      if (data.ownerAgentId) await assertBelongsToCompany(db, agents, data.ownerAgentId, companyId, "Owner agent");
      return db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    update: async (id: string, data: Partial<typeof goals.$inferInsert>) => {
      // WC-162: same FK-existence guard as create. Resolve the goal's company to scope
      // the check; a missing goal falls through to the update (returns null → 404).
      if (data.parentId || data.ownerAgentId) {
        const existing = await db
          .select({ companyId: goals.companyId })
          .from(goals)
          .where(eq(goals.id, id))
          .then((rows) => rows[0] ?? null);
        if (existing) {
          if (data.parentId) await assertBelongsToCompany(db, goals, data.parentId, existing.companyId, "Parent goal");
          if (data.ownerAgentId) await assertBelongsToCompany(db, agents, data.ownerAgentId, existing.companyId, "Owner agent");
        }
      }
      return db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // WC-135: issues.goal_id / projects.goal_id / cost_events.goal_id /
        // finance_events.goal_id reference goals.id with NO onDelete. A goal is an
        // organizational grouping — DETACH its issues/projects (don't delete) and
        // PRESERVE billing (null the link) so delete(goals) doesn't FK-violate.
        await tx.update(issues).set({ goalId: null }).where(eq(issues.goalId, id));
        await tx.update(projects).set({ goalId: null }).where(eq(projects.goalId, id));
        await tx.update(costEvents).set({ goalId: null }).where(eq(costEvents.goalId, id));
        await tx.update(financeEvents).set({ goalId: null }).where(eq(financeEvents.goalId, id));
        return await tx
          .delete(goals)
          .where(eq(goals.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      }),
  };
}
