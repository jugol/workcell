import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, companies, createDb } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-29 activity_log immutability embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-29 activity_log immutability (PLAN §9 #10)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let insertedId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc29-activity-log-");
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
    insertedId = randomUUID();
    await db.insert(activityLog).values({
      id: insertedId,
      companyId,
      actorType: "user",
      actorId: "tester",
      action: "test.event",
      entityType: "company",
      entityId: companyId,
      details: { initial: true },
    });
  });

  afterEach(async () => {
    // TRUNCATE bypasses row triggers, so the test cleanup itself is allowed.
    await db.execute("truncate table companies, activity_log restart identity cascade" as any);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("blocks UPDATE on an activity_log row with a clear error", async () => {
    await expect(
      db.update(activityLog).set({ action: "tampered" }).where(eq(activityLog.id, insertedId)),
    ).rejects.toThrow(/Failed query: (update|delete)/);
  });

  it("blocks DELETE on an activity_log row with a clear error", async () => {
    await expect(
      db.delete(activityLog).where(eq(activityLog.id, insertedId)),
    ).rejects.toThrow(/Failed query: (update|delete)/);
  });

  it("allows fresh INSERTs (the trigger guards only mutations)", async () => {
    const otherId = randomUUID();
    await db.insert(activityLog).values({
      id: otherId,
      companyId,
      actorType: "user",
      actorId: "tester",
      action: "test.followup",
      entityType: "company",
      entityId: companyId,
      details: {},
    });
    const rows = await db.select({ id: activityLog.id }).from(activityLog);
    expect(rows.map((r) => r.id).sort()).toEqual([insertedId, otherId].sort());
  });

  it("preserves the original row content after a failed UPDATE attempt", async () => {
    try {
      await db.update(activityLog).set({ action: "x" }).where(eq(activityLog.id, insertedId));
    } catch {
      // expected
    }
    const row = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.id, insertedId))
      .then((r) => r[0]);
    expect(row.action).toBe("test.event");
  });
});
