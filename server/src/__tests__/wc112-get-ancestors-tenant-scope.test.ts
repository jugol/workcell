import { randomUUID } from "node:crypto";
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
    `Skipping WC-112 getAncestors tenant-scope tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("WC-112 getAncestors is tenant-scoped (cross-tenant leak fix)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workcell-wc112-ancestors-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    await db.execute("truncate table companies, issues restart identity cascade" as any);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany(prefix: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Co ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function makeIssue(companyId: string, title: string, parentId: string | null = null) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title,
      status: "todo",
      priority: "medium",
      workMode: "standard",
      parentId,
    });
    return id;
  }

  it("does NOT traverse a cross-company parentId (no cross-tenant leak)", async () => {
    const companyA = await makeCompany("AAA");
    const companyB = await makeCompany("BBB");
    // Victim issue in company B with sensitive content.
    const victimId = await makeIssue(companyB, "Company B SECRET roadmap");
    // Attacker's issue in company A points its parentId at the victim — the
    // self-FK has no same-company constraint, so this is storable.
    const attackerChildId = await makeIssue(companyA, "Attacker child", victimId);

    const ancestors = await svc.getAncestors(attackerChildId);

    expect(ancestors).toHaveLength(0);
    expect(ancestors.some((a) => a.id === victimId)).toBe(false);
    expect(ancestors.some((a) => a.title.includes("SECRET"))).toBe(false);
  });

  it("DOES traverse a same-company parent chain (no regression)", async () => {
    const companyA = await makeCompany("AAA");
    const grandparentId = await makeIssue(companyA, "Grandparent");
    const parentId = await makeIssue(companyA, "Parent", grandparentId);
    const childId = await makeIssue(companyA, "Child", parentId);

    const ancestors = await svc.getAncestors(childId);

    expect(ancestors.map((a) => a.title)).toEqual(["Parent", "Grandparent"]);
    expect(ancestors.map((a) => a.id)).toEqual([parentId, grandparentId]);
  });

  it("stops the walk at the first cross-company hop (mixed chain)", async () => {
    const companyA = await makeCompany("AAA");
    const companyB = await makeCompany("BBB");
    // A legit same-company parent whose own parentId crosses into company B.
    const foreignGrandparentId = await makeIssue(companyB, "Foreign grandparent");
    const sameCompanyParentId = await makeIssue(companyA, "Same-company parent", foreignGrandparentId);
    const childId = await makeIssue(companyA, "Child", sameCompanyParentId);

    const ancestors = await svc.getAncestors(childId);

    expect(ancestors.map((a) => a.title)).toEqual(["Same-company parent"]);
    expect(ancestors.some((a) => a.id === foreignGrandparentId)).toBe(false);
  });

  // WC-138: write-path guard (defense-in-depth over the read scoping above) —
  // a cross-tenant parentId must never be storable in the first place.
  it("update() REJECTS setting a cross-company parentId", async () => {
    const companyA = await makeCompany("AAA");
    const companyB = await makeCompany("BBB");
    const victimId = await makeIssue(companyB, "Company B SECRET roadmap");
    const childId = await makeIssue(companyA, "A child");

    await expect(svc.update(childId, { parentId: victimId })).rejects.toThrow(
      /not found in this company/i,
    );
  });

  it("update() ALLOWS a same-company parentId (no regression)", async () => {
    const companyA = await makeCompany("AAA");
    const parentId = await makeIssue(companyA, "A parent");
    const childId = await makeIssue(companyA, "A child");

    const updated = await svc.update(childId, { parentId });
    expect(updated?.parentId).toBe(parentId);
  });

  it("create() REJECTS a cross-company parentId", async () => {
    const companyA = await makeCompany("AAA");
    const companyB = await makeCompany("BBB");
    const victimId = await makeIssue(companyB, "Company B SECRET roadmap");

    await expect(
      svc.create(companyA, { title: "Attacker child", parentId: victimId }),
    ).rejects.toThrow(/not found in this company/i);
  });

  // WC-140: tenant-isolation invariant for projectId/goalId (sibling of WC-138).
  // A project/goal ref that does not belong to the company is rejected — this is
  // exactly the cross-tenant case (another company's project is, to this company,
  // "not found").
  it("create() REJECTS a projectId not belonging to the company", async () => {
    const companyA = await makeCompany("AAA");
    await expect(
      svc.create(companyA, { title: "x", projectId: randomUUID() }),
    ).rejects.toThrow(/project not found in this company/i);
  });

  it("create() REJECTS a goalId not belonging to the company", async () => {
    const companyA = await makeCompany("AAA");
    await expect(
      svc.create(companyA, { title: "x", goalId: randomUUID() }),
    ).rejects.toThrow(/goal not found in this company/i);
  });

  it("update() REJECTS a projectId not belonging to the company", async () => {
    const companyA = await makeCompany("AAA");
    const issueId = await makeIssue(companyA, "A issue");
    await expect(
      svc.update(issueId, { projectId: randomUUID() }),
    ).rejects.toThrow(/project not found in this company/i);
  });
});
