import { expect, test, request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * E2E: WC-12 + WC-13 + WC-14 Compound flow.
 *
 * Verifies the full D19 first-cycle chain end-to-end through a real server boot:
 *
 *   1. Seed a company + a `todo` issue (no execution policy) via the API.
 *   2. Attach a proof bundle (proof-gated Done satisfied).
 *   3. PATCH to status=done → WC-12 auto-creates the `compound-checklist`
 *      document with the 5-section template.
 *   4. PUT-update the checklist body so section 5 has real follow-up bullets.
 *   5. Open the issue detail page; the compound-checklist document is visible.
 *   6. Open its "Document actions" menu and click "Process follow-ups" (WC-14
 *      UI surface → WC-13 backend route).
 *   7. Verify the status line confirms creation and the child issues exist
 *      via the API with the right shape (originKind=compound_followup,
 *      parentId linked, status=backlog).
 *
 * Hermetic — no LLM involved. The board actor (local_trusted) drives the
 * transitions; the checklist body is filled via API to remove dependence on
 * a Planner agent at this stage. Real auto-fill is a later slice.
 */

const SKIP_LLM = process.env.WORKCELL_E2E_SKIP_LLM !== "false";

const PORT = Number(process.env.WORKCELL_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

let boardRequest: APIRequestContext;
let companyId: string;
let companyPrefix: string;

test.beforeAll(async () => {
  boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });

  const healthRes = await boardRequest.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  expect(health.deploymentMode).toBe("local_trusted");

  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, {
    data: { name: `E2E-Compound-${Date.now()}` },
  });
  expect(companyRes.ok(), `POST /api/companies → ${companyRes.status()}: ${await companyRes.text()}`).toBe(true);
  const company = await companyRes.json();
  companyId = company.id;
  companyPrefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";
});

test.afterAll(async () => {
  await boardRequest?.dispose();
});

// Stay hermetic — no agent/LLM.
test.skip(!SKIP_LLM, "compound-flow e2e runs in skip-LLM mode only");

test("Done → compound-checklist auto-created → Process follow-ups creates child issues", async ({ page }) => {
  // --- 1. Seed an execution issue. ---
  const title = `Compound flow ${Date.now()}`;
  const createRes = await boardRequest.post(`${BASE_URL}/api/companies/${companyId}/issues`, {
    data: { title, status: "todo", priority: "medium", workMode: "standard" },
  });
  expect(createRes.ok(), `create issue → ${createRes.status()}: ${await createRes.text()}`).toBe(true);
  const issue = await createRes.json();
  const issueId = issue.id as string;
  const issueIdentifier = (issue.identifier ?? issue.id) as string;
  const issuePath = `/${companyPrefix}/issues/${issueIdentifier}`;

  // --- 2. Attach proof so the proof-gate lets us transition to done. ---
  const proofRes = await boardRequest.post(`${BASE_URL}/api/issues/${issueId}/work-products`, {
    data: { type: "proof", provider: "workcell", title: "Proof", status: "active" },
  });
  expect(proofRes.ok(), `create proof → ${proofRes.status()}: ${await proofRes.text()}`).toBe(true);

  // --- 3. PATCH to done — WC-12 auto-creates the compound-checklist doc. ---
  const doneRes = await boardRequest.patch(`${BASE_URL}/api/issues/${issueId}`, {
    data: { status: "done" },
  });
  expect(doneRes.ok(), `mark done → ${doneRes.status()}: ${await doneRes.text()}`).toBe(true);

  // Confirm the checklist exists.
  const checklistRes = await boardRequest.get(
    `${BASE_URL}/api/issues/${issueId}/documents/compound-checklist`,
  );
  expect(checklistRes.ok(), `checklist auto-created → ${checklistRes.status()}`).toBe(true);
  const checklist = await checklistRes.json();
  expect(checklist.key).toBe("compound-checklist");
  expect(String(checklist.body)).toContain("## 5. Follow-up issues");

  // --- 4. Fill section 5 with real follow-up bullets via PUT-upsert. ---
  const filledBody = [
    "# Compound checklist",
    "",
    "## 5. Follow-up issues",
    "",
    "- E2E follow-up alpha",
    "- E2E follow-up beta",
  ].join("\n");
  const putRes = await boardRequest.put(
    `${BASE_URL}/api/issues/${issueId}/documents/compound-checklist`,
    {
      data: {
        title: checklist.title ?? "Compound checklist",
        format: "markdown",
        body: filledBody,
        baseRevisionId: checklist.latestRevisionId,
      },
    },
  );
  expect(putRes.ok(), `fill checklist → ${putRes.status()}: ${await putRes.text()}`).toBe(true);

  // --- 5. Open the issue detail page. ---
  await page.goto(issuePath);
  // Document key chip renders the key text; "compound-checklist" is unique
  // enough to wait on as a readiness signal.
  await expect(page.getByText("compound-checklist").first()).toBeVisible({ timeout: 15_000 });

  // --- 6. Open the document actions menu and click Process follow-ups. ---
  // The compound-checklist document has a `Document actions` MoreHorizontal
  // button. There may be one per document; we scope to the compound-checklist
  // card by finding its key chip and walking to the menu trigger.
  const checklistCard = page.locator(`#document-compound-checklist`);
  await expect(checklistCard).toBeVisible({ timeout: 15_000 });
  await checklistCard.getByTitle("Document actions").click();

  const processItem = page.getByRole("menuitem", { name: /Process follow-ups/i });
  await expect(processItem).toBeVisible();
  await processItem.click();

  // --- 7. Status line confirms the count, children appear via API. ---
  await expect(page.getByText(/Created 2 follow-up issues\./)).toBeVisible({ timeout: 10_000 });

  // Pull all issues for the company and assert two children with our titles
  // exist, linked to the parent via parentId, with originKind=compound_followup.
  await expect
    .poll(
      async () => {
        const res = await boardRequest.get(
          `${BASE_URL}/api/companies/${companyId}/issues?parentId=${issueId}`,
        );
        if (!res.ok()) return -1;
        const list = await res.json();
        return Array.isArray(list)
          ? list.filter((row: any) => row.originKind === "compound_followup").length
          : -1;
      },
      { timeout: 10_000 },
    )
    .toBe(2);

  const childListRes = await boardRequest.get(
    `${BASE_URL}/api/companies/${companyId}/issues?parentId=${issueId}`,
  );
  expect(childListRes.ok()).toBe(true);
  const children = (await childListRes.json()) as Array<{
    title: string;
    status: string;
    parentId: string | null;
    originKind: string | null;
  }>;
  const compoundChildren = children.filter((row) => row.originKind === "compound_followup");
  const titles = compoundChildren.map((row) => row.title).sort();
  expect(titles).toEqual(["E2E follow-up alpha", "E2E follow-up beta"]);
  for (const child of compoundChildren) {
    expect(child.status).toBe("backlog");
    expect(child.parentId).toBe(issueId);
  }
});
