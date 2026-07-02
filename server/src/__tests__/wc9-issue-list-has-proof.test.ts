import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, issues, issueWorkProducts } from "@workcell/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { workProductService } from "../services/work-products.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WC-9 issue-list hasProof embedded Postgres tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let companyId: string;
let issuePrefix: string;

describeEmbeddedPostgres("WC-9 issue list carries hasProof for each row", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let wpSvc!: ReturnType<typeof workProductService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc9-issue-list-has-proof-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    wpSvc = workProductService(db);
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
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(title: string): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "todo",
      priority: "medium",
    });
    return issueId;
  }

  async function attachProof(issueId: string, type: "proof" | "document" = "proof") {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type,
      provider: "workcell",
      title: type === "proof" ? "Execution proof" : "Design note",
      status: "active",
    });
  }

  it("findIssueIdsWithProof returns the subset of provided issue IDs that have a type:\"proof\" work product", async () => {
    const withProofId = await seedIssue("Has proof");
    const withDocumentId = await seedIssue("Has only a document"); // non-proof
    const bareId = await seedIssue("Nothing attached");

    await attachProof(withProofId);
    await attachProof(withDocumentId, "document");

    const result = await wpSvc.findIssueIdsWithProof(companyId, [
      withProofId,
      withDocumentId,
      bareId,
    ]);

    expect(result.has(withProofId)).toBe(true);
    // A non-proof artifact must NOT mark hasProof — same proof-type specificity
    // the WC-3 gate enforces.
    expect(result.has(withDocumentId)).toBe(false);
    expect(result.has(bareId)).toBe(false);
  });

  it("returns an empty set for an empty input (short-circuits the query)", async () => {
    const result = await wpSvc.findIssueIdsWithProof(companyId, []);
    expect(result.size).toBe(0);
  });

  it("issueService.list populates hasProof for each returned row", async () => {
    const provedId = await seedIssue("Proven issue");
    const bareId = await seedIssue("Bare issue");

    await attachProof(provedId);

    const rows = await svc.list(companyId);
    const provedRow = rows.find((row) => row.id === provedId);
    const bareRow = rows.find((row) => row.id === bareId);

    expect(provedRow).toBeDefined();
    expect(bareRow).toBeDefined();
    expect(provedRow?.hasProof).toBe(true);
    // hasProof is explicitly `false` (not undefined) — the chip is positive-only,
    // but consumers can still distinguish "verified absent" from "unknown".
    expect(bareRow?.hasProof).toBe(false);
  });
});
