import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue executionState concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// WC-163: two PATCHes that both recompute executionState from the same version used to
// silently clobber each other (lost update — e.g. a reviewer approving a stage vs. an
// agent setting a reviewRequest). svc.update now guards the executionState write with
// an optimistic-concurrency INTEGER version (execution_state_version): only one writer
// matches the version, the other matches 0 rows and gets a 409 conflict. Deterministic
// regardless of timing: both pass the same version, so whichever UPDATE runs first bumps
// it and the other can no longer match. (An integer token avoids the jsonb-serialization
// mismatch that made the earlier raw-jsonb pre-image approach false-409 on every PATCH.)
describeEmbeddedPostgres("WC-163: issue executionState optimistic concurrency", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-issue-execstate-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Workcell",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // execution_state_version defaults to 0.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Race",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });
    return { companyId, issueId };
  }

  it("rejects the loser of two concurrent executionState updates with 409 (no silent loss)", async () => {
    const { issueId } = await seedIssue();

    const results = await Promise.allSettled([
      svc.update(issueId, { executionState: { v: 1 } as never, expectedExecutionStateVersion: 0 }),
      svc.update(issueId, { executionState: { v: 2 } as never, expectedExecutionStateVersion: 0 }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled, JSON.stringify(results)).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });

    // The winner's value is persisted intact and the version advanced exactly once.
    const final = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]);
    expect(final.executionStateVersion).toBe(1);
    expect([1, 2]).toContain((final.executionState as { v: number }).v);
  });

  it("allows sequential executionState updates (version advances, no false conflict)", async () => {
    const { issueId } = await seedIssue();

    const r1 = await svc.update(issueId, {
      executionState: { v: 1 } as never,
      expectedExecutionStateVersion: 0,
    });
    expect(r1!.executionStateVersion).toBe(1);

    const r2 = await svc.update(issueId, {
      executionState: { v: 2 } as never,
      expectedExecutionStateVersion: 1,
    });
    expect(r2!.executionStateVersion).toBe(2);
    expect((r2!.executionState as { v: number }).v).toBe(2);
  });

  it("does not guard non-executionState updates (no false conflict)", async () => {
    const { issueId } = await seedIssue();
    const updated = await svc.update(issueId, { title: "Renamed" });
    expect(updated?.title).toBe("Renamed");
  });

  it("WC-164: a direct executionState write (e.g. a monitor tick) bumps the version via trigger", async () => {
    const { issueId } = await seedIssue();
    // Simulate a non-route writer (monitor/recovery) updating executionState directly,
    // bypassing the PATCH path's explicit bump. The DB trigger must still advance
    // execution_state_version so the route's OCC detects a concurrent monitor change.
    await db.update(issues).set({ executionState: { monitor: "triggered" } as never }).where(eq(issues.id, issueId));
    const afterEs = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]);
    expect(afterEs.executionStateVersion).toBe(1);

    // A non-executionState update does NOT bump the version (trigger WHEN guard).
    await db.update(issues).set({ title: "Renamed" }).where(eq(issues.id, issueId));
    const afterTitle = await db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0]);
    expect(afterTitle.executionStateVersion).toBe(1);
  });
});
