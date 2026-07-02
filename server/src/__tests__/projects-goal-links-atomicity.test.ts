import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, goals, projectGoals, projects, createDb } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping projects goal-link atomicity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// WC-160: projectService.create/update wrote the project row and its project_goals
// join rows on the bare db handle, NOT in a transaction. A mid-sequence failure
// (here: a goalId that violates the project_goals.goalId -> goals.id FK) left a
// committed-but-inconsistent state. create() left an orphaned project with zero goal
// links; update() was worse — syncGoalLinks DELETEs all existing links then
// re-inserts, so a failed re-insert WIPED the project's previously-good links. These
// tests assert the whole sequence now rolls back atomically.
describeEmbeddedPostgres("WC-160: projects goal-link atomicity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-projects-atomicity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectGoals);
    await db.delete(projects);
    await db.delete(goals);
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

  it("rolls back the project insert when a goal-link insert fails (no orphaned project)", async () => {
    const companyId = await seedCompany();
    const realGoalId = randomUUID();
    await db.insert(goals).values({ id: realGoalId, companyId, title: "Real goal" });
    const missingGoalId = randomUUID(); // not a real goal -> project_goals FK violation

    await expect(
      projectService(db).create(companyId, { name: "Doomed", goalIds: [realGoalId, missingGoalId] }),
    ).rejects.toThrow();

    // The whole create must roll back: no project row, no partial goal links.
    const remainingProjects = await db.select().from(projects).where(eq(projects.companyId, companyId));
    expect(remainingProjects).toHaveLength(0);
    const remainingLinks = await db.select().from(projectGoals).where(eq(projectGoals.companyId, companyId));
    expect(remainingLinks).toHaveLength(0);
  });

  it("preserves existing goal links when an update's re-sync fails (no wipe)", async () => {
    const companyId = await seedCompany();
    const goalA = randomUUID();
    const goalB = randomUUID();
    await db.insert(goals).values([
      { id: goalA, companyId, title: "Goal A" },
      { id: goalB, companyId, title: "Goal B" },
    ]);

    // Create a project linked to goalA (atomic, succeeds).
    const created = await projectService(db).create(companyId, { name: "Keeper", goalIds: [goalA] });
    const initialLinks = await db
      .select({ goalId: projectGoals.goalId })
      .from(projectGoals)
      .where(eq(projectGoals.projectId, created.id));
    expect(initialLinks.map((row) => row.goalId)).toEqual([goalA]);

    // An update whose goal re-sync FK-violates on a missing goal must roll back.
    const missingGoalId = randomUUID();
    await expect(
      projectService(db).update(created.id, { goalIds: [goalB, missingGoalId] }),
    ).rejects.toThrow();

    // The original link (goalA) must SURVIVE — syncGoalLinks' delete-all was rolled
    // back, not committed. The legacy scalar goalId must also be unchanged.
    const linksAfter = await db
      .select({ goalId: projectGoals.goalId })
      .from(projectGoals)
      .where(eq(projectGoals.projectId, created.id));
    expect(linksAfter.map((row) => row.goalId)).toEqual([goalA]);
    const [projectRow] = await db
      .select({ goalId: projects.goalId })
      .from(projects)
      .where(eq(projects.id, created.id));
    expect(projectRow?.goalId).toBe(goalA);
  });
});
