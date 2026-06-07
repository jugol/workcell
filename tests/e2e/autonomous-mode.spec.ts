import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Autonomous (unattended) mode — skip user-participation gates (WC-168).
 *
 * Drives the real product through the multi-agent workflow with autonomous mode
 * ON, proving that a person is NOT required in the loop:
 *
 *   1. A "user design-review" execution stage auto-approves (the human review
 *      step the designer's mock would normally wait on).
 *   2. A user stage followed by an agent QA stage skips the user and lands on
 *      the QA agent — then the agent completes it.
 *   3. Agent QA stages are NOT skipped — the autonomous quality loop still runs.
 *
 * Autonomous mode is an instance-global flag, but it only affects USER-only
 * execution stages, which no other e2e spec uses — so enabling it here cannot
 * interfere with concurrent specs. It is still restored to OFF in afterAll.
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts webServer env).
 */

const PORT = Number(process.env.WORKCELL_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-Autonomous-${Date.now()}`;
// Any truthy userId works — user participants are not validated against a real
// user directory, and autonomous mode auto-approves the stage regardless of who.
const HUMAN_REVIEWER_USER_ID = "human-product-reviewer";

interface AgentAuth {
  agentId: string;
  token: string;
  keyId: string;
  request: APIRequestContext;
}

interface TestContext {
  companyId: string;
  executor: AgentAuth;
  reviewer: AgentAuth;
  boardRequest: APIRequestContext;
  issueIds: string[];
}

async function createAgentRequest(token: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

async function invokeHeartbeat(board: APIRequestContext, agentId: string): Promise<string> {
  const res = await board.post(`${BASE_URL}/api/agents/${agentId}/heartbeat/invoke`);
  expect(res.ok()).toBe(true);
  const run = await res.json();
  return run.id;
}

async function getIssueRunLockState(board: APIRequestContext, issueId: string) {
  const res = await board.get(`${BASE_URL}/api/issues/${issueId}`);
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  return {
    assigneeAgentId: issue.assigneeAgentId ?? null,
    checkoutRunId: issue.checkoutRunId ?? null,
    executionRunId: issue.executionRunId ?? null,
  };
}

/** PATCH an issue as an agent with a fresh heartbeat run ID (no checkout). */
async function agentPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  data: Record<string, unknown>,
) {
  const runId = await invokeHeartbeat(board, agent.agentId);
  return agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Workcell-Run-Id": runId },
    data,
  });
}

/** Checkout an issue as an agent, then PATCH it. Used for executor mark-done. */
async function agentCheckoutAndPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  expectedStatuses: string[],
  patchData: Record<string, unknown>,
) {
  const runId = await invokeHeartbeat(board, agent.agentId);
  const checkoutRes = await agent.request.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
    headers: { "X-Workcell-Run-Id": runId },
    data: { agentId: agent.agentId, expectedStatuses },
  });
  if (!checkoutRes.ok()) {
    if (checkoutRes.status() === 409) {
      const lock = await getIssueRunLockState(board, issueId);
      const lockedRunId = lock.checkoutRunId ?? lock.executionRunId;
      const res = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
        headers: { "X-Workcell-Run-Id": lockedRunId ?? runId },
        data: patchData,
      });
      if (res.ok() && lock.assigneeAgentId === agent.agentId) return res;
    }
    const boardCheckout = await board.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
      data: { agentId: agent.agentId, expectedStatuses },
    });
    if (!boardCheckout.ok()) {
      throw new Error(`Board checkout failed: ${await boardCheckout.text()}`);
    }
    return board.patch(`${BASE_URL}/api/issues/${issueId}`, { data: patchData });
  }
  return agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Workcell-Run-Id": runId },
    data: patchData,
  });
}

async function setAutonomousMode(board: APIRequestContext, enabled: boolean) {
  const res = await board.patch(`${BASE_URL}/api/instance/settings/experimental`, {
    data: { autonomousMode: enabled },
  });
  expect(res.ok(), `toggle autonomousMode=${enabled} → ${res.status()}: ${await res.text()}`).toBe(true);
  // PATCH /instance/settings/experimental returns the experimental object flat.
  const experimental = await res.json();
  expect(experimental.autonomousMode).toBe(enabled);
}

async function setupCompany(boardRequest: APIRequestContext): Promise<TestContext> {
  const healthRes = await boardRequest.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(`Autonomous-mode e2e requires local_trusted, got "${health.deploymentMode}".`);
  }

  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, { data: { name: COMPANY_NAME } });
  expect(companyRes.ok(), `POST /companies → ${companyRes.status()}: ${await companyRes.text()}`).toBe(true);
  const company = await companyRes.json();

  async function createAgent(name: string, role: string, title: string): Promise<AgentAuth> {
    const agentRes = await boardRequest.post(`${BASE_URL}/api/companies/${company.id}/agent-hires`, {
      data: {
        name,
        role,
        title,
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.stdout.write('done\\n')"] },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const hire = await agentRes.json();
    if (hire.approval) {
      const approvalRes = await boardRequest.post(`${BASE_URL}/api/approvals/${hire.approval.id}/approve`, {
        data: { decisionNote: "Approved for autonomous-mode e2e setup." },
      });
      expect(approvalRes.ok()).toBe(true);
    }
    const keyRes = await boardRequest.post(`${BASE_URL}/api/agents/${hire.agent.id}/keys`, {
      data: { name: `e2e-${name.toLowerCase()}` },
    });
    expect(keyRes.ok()).toBe(true);
    const keyData = await keyRes.json();
    return { agentId: hire.agent.id, token: keyData.token, keyId: keyData.id, request: await createAgentRequest(keyData.token) };
  }

  const executor = await createAgent("Developer", "engineer", "Software Engineer");
  const reviewer = await createAgent("QA", "qa", "QA Engineer");

  return { companyId: company.id, executor, reviewer, boardRequest, issueIds: [] };
}

async function createIssueWithPolicy(ctx: TestContext, title: string, stages: unknown[]) {
  const res = await ctx.boardRequest.post(`${BASE_URL}/api/companies/${ctx.companyId}/issues`, {
    data: { title, status: "in_progress", assigneeAgentId: ctx.executor.agentId, executionPolicy: { stages } },
  });
  expect(res.ok(), `create issue → ${res.status()}: ${await res.text()}`).toBe(true);
  const issue = await res.json();
  ctx.issueIds.push(issue.id);
  // Proof-gated Done (WC-3): attach a proof bundle so the issue can reach done.
  const proofRes = await ctx.boardRequest.post(`${BASE_URL}/api/issues/${issue.id}/work-products`, {
    data: { type: "proof", provider: "workcell", title: "Execution proof", status: "active" },
  });
  expect(proofRes.ok()).toBe(true);
  return issue;
}

test.describe("Autonomous mode (skip user participation)", () => {
  let ctx: TestContext;

  test.beforeAll(async () => {
    const boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });
    ctx = await setupCompany(boardRequest);
    await setAutonomousMode(boardRequest, true);
  });

  test.afterAll(async () => {
    if (!ctx) return;
    const board = ctx.boardRequest;
    // CRITICAL: restore the instance-global flag so it cannot leak to other specs.
    await setAutonomousMode(board, false).catch(() => {});
    for (const agent of [ctx.executor, ctx.reviewer]) await agent.request.dispose();
    for (const issueId of ctx.issueIds) {
      await board.patch(`${BASE_URL}/api/issues/${issueId}`, { data: { status: "cancelled", comment: "E2E cleanup." } }).catch(() => {});
    }
    for (const agent of [ctx.executor, ctx.reviewer]) {
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}/keys/${agent.keyId}`).catch(() => {});
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}`).catch(() => {});
    }
    await board.delete(`${BASE_URL}/api/companies/${ctx.companyId}`).catch(() => {});
    await board.dispose();
  });

  test("auto-approves a user design-review stage — no human in the loop", async () => {
    const issue = await createIssueWithPolicy(ctx, "Notion-lite: page editor (design OK auto)", [
      { type: "review", participants: [{ type: "user", userId: HUMAN_REVIEWER_USER_ID }] },
    ]);

    // Developer marks done. With autonomous mode the user design-review stage
    // auto-approves and the issue completes — it never parks on the human.
    const res = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issue.id, ["in_progress"],
      { status: "done", comment: "Implemented the page editor." },
    );
    expect(res.ok(), `executor done → ${res.status()}: ${await res.text()}`).toBe(true);
    const done = await res.json();

    expect(done.status).toBe("done");
    expect(done.assigneeUserId ?? null).toBeNull();
    expect(done.executionState.status).toBe("completed");
    expect(done.executionState.completedStageIds).toHaveLength(1);
    // A user stage that is auto-skipped is a silent completion, not an explicit
    // human "approved" decision, so no decision outcome is recorded (consistent
    // with the existing self-review-skip path).
    expect(done.executionState.lastDecisionOutcome ?? null).toBeNull();
  });

  test("skips the user review and lands on the agent QA stage; QA then completes", async () => {
    const issue = await createIssueWithPolicy(ctx, "Notion-lite: blocks (user review + QA)", [
      { type: "review", participants: [{ type: "user", userId: HUMAN_REVIEWER_USER_ID }] },
      { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    ]);
    const userStageId = issue.executionPolicy.stages[0].id;

    // Developer marks done → user stage auto-skipped → parks on the QA agent.
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issue.id, ["in_progress"],
      { status: "done", comment: "Implemented blocks." },
    );
    expect(doneRes.ok()).toBe(true);
    const parked = await doneRes.json();

    expect(parked.status).toBe("in_review");
    expect(parked.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(parked.assigneeUserId ?? null).toBeNull();
    expect(parked.executionState.currentStageType).toBe("review");
    expect(parked.executionState.currentParticipant).toMatchObject({ type: "agent", agentId: ctx.reviewer.agentId });
    // The user stage was completed (skipped), not the QA stage.
    expect(parked.executionState.completedStageIds).toContain(userStageId);

    // The QA agent approves → issue completes.
    const qaRes = await agentPatch(ctx.boardRequest, ctx.reviewer, issue.id, { status: "done", comment: "QA passed." });
    expect(qaRes.ok()).toBe(true);
    const completed = await qaRes.json();
    expect(completed.status).toBe("done");
    expect(completed.executionState.status).toBe("completed");
    expect(completed.executionState.completedStageIds).toHaveLength(2);
  });

  test("does NOT skip agent QA stages — the autonomous quality loop still runs", async () => {
    const issue = await createIssueWithPolicy(ctx, "Notion-lite: sync (QA must run)", [
      { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    ]);

    // Developer marks done → must PARK on the QA agent (agent stages are never skipped).
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issue.id, ["in_progress"],
      { status: "done", comment: "Implemented sync." },
    );
    expect(doneRes.ok()).toBe(true);
    const parked = await doneRes.json();
    expect(parked.status).toBe("in_review");
    expect(parked.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(parked.executionState.currentStageType).toBe("review");
  });
});
