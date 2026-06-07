import { expect, test, request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * E2E: WC-3 proof-gated Done.
 *
 * An issue cannot transition to `done` until a proof bundle (an
 * issue_work_products row with type "proof") exists for it.
 *
 *   1. Seed a company + a `todo` issue (no execution policy) via the API.
 *   2. Open the issue detail page; the Done status option is disabled with a
 *      tooltip telling the operator to attach a proof bundle first.
 *   3. POST a `type:"proof"` work product via the API.
 *   4. Reload; the Done option is enabled and moving the issue there succeeds.
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts webServer env).
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
    data: { name: `E2E-Proof-${Date.now()}` },
  });
  expect(companyRes.ok(), `POST /api/companies → ${companyRes.status()}: ${await companyRes.text()}`).toBe(true);
  const company = await companyRes.json();
  companyId = company.id;
  companyPrefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";
});

test.afterAll(async () => {
  await boardRequest?.dispose();
});

// SKIP_LLM keeps this hermetic: we never invoke an agent/LLM. All transitions
// are driven by the board actor (local_trusted auto-auth) and the UI.
test.skip(!SKIP_LLM, "proof-gated-done e2e runs in skip-LLM mode only");

test("Done is gated until a proof bundle is attached, then succeeds", async ({ page }) => {
  const title = `Proof gate ${Date.now()}`;
  const createRes = await boardRequest.post(`${BASE_URL}/api/companies/${companyId}/issues`, {
    data: { title, status: "todo", priority: "medium" },
  });
  expect(createRes.ok(), `create issue → ${createRes.status()}: ${await createRes.text()}`).toBe(true);
  const issue = await createRes.json();
  const issueId = issue.id as string;
  const issueIdentifier = (issue.identifier ?? issue.id) as string;
  const issuePath = `/${companyPrefix}/issues/${issueIdentifier}`;

  // --- Without a proof bundle, Done is disabled with a tooltip. ---
  await page.goto(issuePath);
  const statusTrigger = page.getByTestId("issue-detail-status-trigger");
  await expect(statusTrigger).toBeVisible({ timeout: 15_000 });

  // The "Add proof bundle" affordance is visible while no proof exists.
  await expect(page.getByTestId("issue-detail-add-proof")).toBeVisible();

  await statusTrigger.click();
  const doneOptionDisabled = page.getByRole("button", { name: "Done", disabled: true });
  await expect(doneOptionDisabled).toBeVisible();
  await expect(doneOptionDisabled).toHaveAttribute("title", "Attach a proof bundle first");
  // Close the popover.
  await page.keyboard.press("Escape");

  // --- Attach a proof bundle via the API. ---
  const proofRes = await boardRequest.post(`${BASE_URL}/api/issues/${issueId}/work-products`, {
    data: { type: "proof", provider: "workcell", title: "Proof", status: "active" },
  });
  expect(proofRes.ok(), `create proof → ${proofRes.status()}: ${await proofRes.text()}`).toBe(true);

  // --- After reload, Done is enabled and moving there succeeds. ---
  await page.reload();
  await expect(page.getByTestId("issue-detail-add-proof")).toHaveCount(0);
  await statusTrigger.click();
  const doneOption = page.getByRole("button", { name: "Done" });
  await expect(doneOption).toBeEnabled();
  await doneOption.click();

  // The issue transitions to done (verified via the API to avoid DOM races).
  await expect
    .poll(
      async () => {
        const res = await boardRequest.get(`${BASE_URL}/api/issues/${issueId}`);
        expect(res.ok()).toBe(true);
        return (await res.json()).status;
      },
      { timeout: 10_000 },
    )
    .toBe("done");
});
