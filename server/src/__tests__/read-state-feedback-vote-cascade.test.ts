import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  companies,
  issues,
  issueReadStates,
  feedbackVotes,
  feedbackExports,
} from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// WC-217 (Item 1): migration 0114 cascades the parent FKs of issue_read_states
// and feedback_votes. Before 0114 both carried ON DELETE no action, so deleting
// the parent issue/company at the DB level FK-violated (23503). Assert the
// parent delete now cascades the derived child rows (and that a feedback_vote's
// already-cascading feedback_exports child goes with it).

process.env.WORKCELL_HOME ??= "/tmp/workcell-test-home";
process.env.WORKCELL_INSTANCE_ID ??= "vitest";
process.env.WORKCELL_LOG_DIR ??= "/tmp/workcell-test-home/logs";
process.env.WORKCELL_IN_WORKTREE ??= "false";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping read-state/feedback-vote cascade tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("issue_read_states / feedback_votes ON DELETE cascade (0114)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-read-state-cascade-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    await db.delete(feedbackExports);
    await db.delete(feedbackVotes);
    await db.delete(issueReadStates);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndIssue() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Cascade Co" })
      .returning({ id: companies.id });
    const [issue] = await db
      .insert(issues)
      .values({ companyId: company!.id, title: "Cascade issue" })
      .returning({ id: issues.id });
    return { companyId: company!.id, issueId: issue!.id };
  }

  it("deleting the parent issue cascades read states and feedback votes (and exports)", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();

    await db.insert(issueReadStates).values({
      companyId,
      issueId,
      userId: "user-1",
    });
    const [vote] = await db
      .insert(feedbackVotes)
      .values({
        companyId,
        issueId,
        targetType: "issue",
        targetId: issueId,
        authorUserId: "user-1",
        vote: "up",
      })
      .returning({ id: feedbackVotes.id });
    await db.insert(feedbackExports).values({
      companyId,
      feedbackVoteId: vote!.id,
      issueId,
      authorUserId: "user-1",
      targetType: "issue",
      targetId: issueId,
      vote: "up",
      targetSummary: {},
    });

    // Pre-0114 this threw FK 23503 (issue_read_states / feedback_votes ON DELETE
    // no action); post-0114 the issue delete cascades them.
    await db.delete(issues).where(eq(issues.id, issueId));

    expect(await db.select().from(issueReadStates).where(eq(issueReadStates.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(feedbackVotes).where(eq(feedbackVotes.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(feedbackExports).where(eq(feedbackExports.feedbackVoteId, vote!.id))).toHaveLength(0);
  });

  it("company teardown order (issues then company) clears the children with no FK violation", async () => {
    // issues.company_id is itself non-cascading (RESTRICT), so a company can only
    // be deleted after its issues — at which point the issue-FK cascade already
    // reaps these children. The new company-FK cascade is defense-in-depth for
    // any future/admin path that deletes a child without its issue. This asserts
    // the realistic teardown order leaves no rows and no 23503.
    const { companyId, issueId } = await seedCompanyAndIssue();

    await db.insert(issueReadStates).values({ companyId, issueId, userId: "user-2" });
    await db.insert(feedbackVotes).values({
      companyId,
      issueId,
      targetType: "issue",
      targetId: issueId,
      authorUserId: "user-2",
      vote: "down",
    });

    await db.delete(issues).where(eq(issues.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));

    expect(await db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(feedbackVotes).where(eq(feedbackVotes.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
  });
});
