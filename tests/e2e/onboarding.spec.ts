import { test, expect } from "@playwright/test";

/**
 * E2E: Onboarding wizard flow (skip_llm mode).
 *
 * Walks through the 4-step OnboardingWizard:
 *   Step 1 — Name your team
 *   Step 2 — Create your first agent (adapter selection + config)
 *   Step 3 — Give it something to do (task creation)
 *   Step 4 — Ready to launch (summary + open issue)
 *
 * By default this runs in skip_llm mode: we do NOT assert that an LLM
 * heartbeat fires. Set WORKCELL_E2E_SKIP_LLM=false to enable LLM-dependent
 * assertions (requires a valid ANTHROPIC_API_KEY).
 */

const SKIP_LLM = process.env.WORKCELL_E2E_SKIP_LLM !== "false";

const COMPANY_NAME = `E2E-Test-${Date.now()}`;
const AGENT_NAME = "Orchestrator";
const TASK_TITLE = "E2E test task";

test.describe("Onboarding wizard", () => {
  test("completes full wizard flow", async ({ page }) => {
    await page.goto("/onboarding");

    const wizardHeading = page.locator("h3", { hasText: "Name your team" });

    await expect(wizardHeading).toBeVisible({ timeout: 5_000 });

    const companyNameInput = page.locator('input[placeholder="Acme Corp"]');
    await companyNameInput.fill(COMPANY_NAME);

    const nextButton = page.getByRole("button", { name: "Next" });
    await nextButton.click();

    await expect(
      page.locator("h3", { hasText: "Create your first agent" })
    ).toBeVisible({ timeout: 30_000 });

    const agentNameInput = page.locator('input[placeholder="Orchestrator"]');
    await expect(agentNameInput).toHaveValue(AGENT_NAME);

    await expect(
      page.locator("button", { hasText: "Claude Code" }).locator("..")
    ).toBeVisible();

    // WC-147: pair collaboration is exposed from the very first agent step.
    await expect(
      page.getByRole("button", { name: "Pair", exact: true })
    ).toBeVisible();

    // WC-145: the "More Agent Adapter Types" disclosure is hidden when there are
    // no extra adapters to reveal (claude/codex are both recommended; process/http
    // are system adapters excluded from the picker). So the disclosure is absent
    // and Process is never offered as a selectable adapter.
    await expect(
      page.getByRole("button", { name: "More Agent Adapter Types" })
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Process" })).toHaveCount(0);

    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.locator("h3", { hasText: "Give it something to do" })
    ).toBeVisible({ timeout: 30_000 });

    const baseUrl = page.url().split("/").slice(0, 3).join("/");
    if (SKIP_LLM) {
      const companiesAfterAgentRes = await page.request.get(`${baseUrl}/api/companies`);
      expect(companiesAfterAgentRes.ok()).toBe(true);
      const companiesAfterAgent = await companiesAfterAgentRes.json();
      const companyAfterAgent = companiesAfterAgent.find(
        (c: { name: string }) => c.name === COMPANY_NAME
      );
      expect(companyAfterAgent).toBeTruthy();

      const agentsAfterCreateRes = await page.request.get(
        `${baseUrl}/api/companies/${companyAfterAgent.id}/agents`
      );
      expect(agentsAfterCreateRes.ok()).toBe(true);
      const agentsAfterCreate = await agentsAfterCreateRes.json();
      const ceoAgentAfterCreate = agentsAfterCreate.find(
        (a: { name: string }) => a.name === AGENT_NAME
      );
      expect(ceoAgentAfterCreate).toBeTruthy();

      const disableWakeRes = await page.request.patch(
        `${baseUrl}/api/agents/${ceoAgentAfterCreate.id}?companyId=${encodeURIComponent(companyAfterAgent.id)}`,
        {
          data: {
            runtimeConfig: {
              heartbeat: {
                enabled: false,
                intervalSec: 300,
                wakeOnDemand: false,
                cooldownSec: 10,
                maxConcurrentRuns: 5,
              },
            },
          },
        }
      );
      expect(disableWakeRes.ok()).toBe(true);
    }

    const taskTitleInput = page.locator(
      'input[placeholder="e.g. Research competitor pricing"]'
    );
    await taskTitleInput.clear();
    await taskTitleInput.fill(TASK_TITLE);

    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.locator("h3", { hasText: "Ready to launch" })
    ).toBeVisible({ timeout: 30_000 });

    await expect(page.locator("text=" + COMPANY_NAME)).toBeVisible();
    await expect(page.locator("text=" + AGENT_NAME)).toBeVisible();
    await expect(page.locator("text=" + TASK_TITLE)).toBeVisible();

    await page.getByRole("button", { name: "Create & Open Issue" }).click();

    await expect(page).toHaveURL(/\/issues\//, { timeout: 30_000 });

    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const company = companies.find(
      (c: { name: string }) => c.name === COMPANY_NAME
    );
    expect(company).toBeTruthy();

    const agentsRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    const ceoAgent = agents.find(
      (a: { name: string }) => a.name === AGENT_NAME
    );
    expect(ceoAgent).toBeTruthy();
    expect(ceoAgent.role).toBe("orchestrator");
    expect(ceoAgent.adapterType).not.toBe("process");

    const instructionsBundleRes = await page.request.get(
      `${baseUrl}/api/agents/${ceoAgent.id}/instructions-bundle?companyId=${company.id}`
    );
    expect(instructionsBundleRes.ok()).toBe(true);
    const instructionsBundle = await instructionsBundleRes.json();
    expect(
      instructionsBundle.files.map((file: { path: string }) => file.path).sort()
    ).toEqual(["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"]);

    const issuesRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/issues`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    const task = issues.find(
      (i: { title: string }) => i.title === TASK_TITLE
    );
    expect(task).toBeTruthy();
    expect(task.assigneeAgentId).toBe(ceoAgent.id);
    expect(task.description).toContain(
      "Break the goal into issues with clear acceptance criteria and a proof surface"
    );
    expect(task.description).not.toContain("github.com/workcell/companies");

    if (!SKIP_LLM) {
      await expect(async () => {
        const res = await page.request.get(
          `${baseUrl}/api/issues/${task.id}`
        );
        const issue = await res.json();
        expect(["in_progress", "done"]).toContain(issue.status);
      }).toPass({ timeout: 120_000, intervals: [5_000] });
    } else {
      await expect
        .poll(async () => {
          const runsRes = await page.request.get(
            `${baseUrl}/api/companies/${company.id}/heartbeat-runs?agentId=${ceoAgent.id}`
          );
          expect(runsRes.ok()).toBe(true);
          const runs = await runsRes.json();
          return Array.isArray(runs) ? runs.length : -1;
        }, { timeout: 10_000, intervals: [500, 1_000, 2_000] })
        .toBe(0);

      // WC-2: the board can ask the planner-capable agent (the CEO created above is
      // planner-capable) to draft a structured issue from a natural-language prompt.
      // In SKIP_LLM mode the CEO's heartbeat is disabled, so the created issue stays a
      // todo draft and we can assert its exact shape without racing the run loop. We do
      // NOT assert the issue-draft document here — that write requires the LLM run.
      const draftPrompt =
        "Add a dark-mode toggle to the settings page so users can switch themes.";
      const draftRes = await page.request.post(
        `${baseUrl}/api/companies/${company.id}/issues/draft-from-prompt`,
        { data: { prompt: draftPrompt } }
      );
      expect(draftRes.status()).toBe(201);
      const draftIssue = await draftRes.json();
      expect(draftIssue.status).toBe("todo");
      expect(draftIssue.workMode).toBe("planning");
      expect(draftIssue.originKind).toBe("planner_draft_request");
      expect(draftIssue.assigneeAgentId).toBe(ceoAgent.id);
      // The drafting instruction is embedded in the description and points the agent at
      // the issue-draft document with the four required sections.
      expect(draftIssue.description).toContain("issue-draft");
      expect(draftIssue.description).toContain("## Acceptance Criteria");
      expect(draftIssue.description).toContain("## Suggested Owner Role");
      expect(draftIssue.description).toContain(draftPrompt);

      // The draft is discoverable on the board's issue list.
      const issuesAfterDraftRes = await page.request.get(
        `${baseUrl}/api/companies/${company.id}/issues`
      );
      expect(issuesAfterDraftRes.ok()).toBe(true);
      const issuesAfterDraft = await issuesAfterDraftRes.json();
      expect(
        issuesAfterDraft.some(
          (i: { id: string; originKind?: string }) =>
            i.id === draftIssue.id && i.originKind === "planner_draft_request"
        )
      ).toBe(true);
    }
  });

  // WC-147: pair-first onboarding. Drives the full Pair path and asserts the
  // backend state — two agents hired and the first task turned into a pair —
  // so the new 2-agent + pairGroupsApi.create launch flow has real proof.
  test("pair mode hires two agents and makes the first task a pair", async ({ page }) => {
    const companyName = `E2E-Pair-${Date.now()}`;
    const counterpartName = "Reviewer";
    const taskTitle = "E2E pair task";

    await page.goto("/onboarding");
    await expect(
      page.locator("h3", { hasText: "Name your team" })
    ).toBeVisible({ timeout: 5_000 });
    await page.locator('input[placeholder="Acme Corp"]').fill(companyName);
    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.locator("h3", { hasText: "Create your first agent" })
    ).toBeVisible({ timeout: 30_000 });

    // Switch to Pair and configure the counterpart agent (owner keeps the
    // default "Orchestrator" name; counterpart adapter defaults to the other
    // recommended model).
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    const counterpartInput = page.locator('input[placeholder="Reviewer"]');
    await expect(counterpartInput).toBeVisible();
    await counterpartInput.fill(counterpartName);
    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.locator("h3", { hasText: "Give it something to do" })
    ).toBeVisible({ timeout: 30_000 });
    const taskInput = page.locator(
      'input[placeholder="e.g. Research competitor pricing"]'
    );
    await taskInput.clear();
    await taskInput.fill(taskTitle);
    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.locator("h3", { hasText: "Ready to launch" })
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Create & Open Issue" }).click();
    await expect(page).toHaveURL(/\/issues\//, { timeout: 30_000 });

    const baseUrl = page.url().split("/").slice(0, 3).join("/");
    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const company = (await companiesRes.json()).find(
      (c: { name: string }) => c.name === companyName
    );
    expect(company).toBeTruthy();

    // Both agents were hired: the orchestrator owner + the counterpart.
    const agentsRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    expect(
      agents.find((a: { name: string }) => a.name === AGENT_NAME)
    ).toBeTruthy();
    expect(
      agents.find((a: { name: string }) => a.name === counterpartName)
    ).toBeTruthy();

    // The first task is now a PAIR (pairGroupsApi.create flipped workOwnerKind).
    const issuesRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/issues`
    );
    expect(issuesRes.ok()).toBe(true);
    const task = (await issuesRes.json()).find(
      (i: { title: string }) => i.title === taskTitle
    );
    expect(task).toBeTruthy();
    expect(task.workOwnerKind).toBe("pair");

    // Drive one pair round (deterministic stub via WORKCELL_PAIR_LIVE_LLM=0) and
    // confirm turns get recorded — proving the full pair execution loop end to
    // end (UI "Run round" → orchestrator → turn ledger), not just creation.
    await expect(page.getByTestId("pair-round-timeline")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Run round", exact: true }).click();

    const groupRes = await page.request.get(
      `${baseUrl}/api/issues/${task.id}/pair-group`
    );
    expect(groupRes.ok()).toBe(true);
    const groupId = (await groupRes.json()).group?.id;
    expect(groupId).toBeTruthy();

    await expect
      .poll(
        async () => {
          const turnsRes = await page.request.get(
            `${baseUrl}/api/pair-groups/${groupId}/turns`
          );
          if (!turnsRes.ok()) return -1;
          const { turns } = await turnsRes.json();
          return Array.isArray(turns) ? turns.length : -1;
        },
        { timeout: 15_000, intervals: [500, 1_000, 2_000] }
      )
      .toBeGreaterThan(0);
  });
});
