import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkcellApiClient } from "./client.js";
import { createToolDefinitions } from "./tools.js";

function makeClient() {
  return new WorkcellApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  });
}

function getTool(name: string) {
  const tool = createToolDefinitions(makeClient()).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("workcell MCP tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("adds auth headers and run id to mutating requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellUpdateIssue");
    await tool.execute({
      issueId: "PAP-1135",
      status: "done",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-123");
    expect((init.headers as Record<string, string>)["X-Workcell-Run-Id"]).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("uses default company id for company-scoped list tools", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([{ id: "issue-1" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellListIssues");
    const response = await tool.execute({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues",
    );
    expect(response.content[0]?.text).toContain("issue-1");
  });

  it("uses default agent id for checkout requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "PAP-1135", status: "in_progress" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellCheckoutIssue");
    await tool.execute({
      issueId: "PAP-1135",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      agentId: "22222222-2222-2222-2222-222222222222",
      expectedStatuses: ["todo", "backlog", "blocked"],
    });
  });

  it("allows create issue requests to omit status so the API applies assignee defaults", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "issue-1", status: "todo" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellCreateIssue");
    await tool.execute({
      title: "Assigned follow-up",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "Assigned follow-up",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
      requestDepth: 0,
    });
  });

  it("defaults issue document format to markdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ key: "plan", latestRevisionNumber: 2 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellUpsertIssueDocument");
    await tool.execute({
      issueId: "PAP-1135",
      key: "plan",
      body: "# Updated",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      format: "markdown",
      body: "# Updated",
    });
  });

  it("controls issue workspace services through the current execution workspace", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        currentExecutionWorkspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [],
        },
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        operation: { id: "operation-1" },
        workspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              serviceName: "web",
              status: "running",
              url: "http://127.0.0.1:5173",
            },
          ],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellControlIssueWorkspaceServices");
    await tool.execute({
      issueId: "PAP-1135",
      action: "restart",
      workspaceCommandId: "web",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookupInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(lookupUrl)).toBe("http://localhost:3100/api/issues/PAP-1135/heartbeat-context");
    expect(lookupInit.method).toBe("GET");

    const [controlUrl, controlInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(controlUrl)).toBe(
      "http://localhost:3100/api/execution-workspaces/44444444-4444-4444-8444-444444444444/runtime-services/restart",
    );
    expect(controlInit.method).toBe("POST");
    expect(JSON.parse(String(controlInit.body))).toEqual({
      workspaceCommandId: "web",
    });
  });

  it("waits for an issue workspace runtime service URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        currentExecutionWorkspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              serviceName: "web",
              status: "running",
              healthStatus: "healthy",
              url: "http://127.0.0.1:5173",
            },
          ],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellWaitForIssueWorkspaceService");
    const response = await tool.execute({
      issueId: "PAP-1135",
      serviceName: "web",
      timeoutSeconds: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.content[0]?.text).toContain("http://127.0.0.1:5173");
  });

  it("creates suggest_tasks interactions with the expected issue-scoped payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "suggest_tasks" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellSuggestTasks");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "run-1:suggest",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "run-1:suggest",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    });
  });

  it("creates request_confirmation interactions with plan target payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "request_confirmation" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellRequestConfirmation");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "confirmation:PAP-1135:plan:33333333-3333-4333-8333-333333333333",
      title: "Plan approval",
      payload: {
        version: 1,
        prompt: "Accept this plan?",
        acceptLabel: "Accept plan",
        allowDeclineReason: true,
        rejectLabel: "Request changes",
        rejectRequiresReason: true,
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 3,
        },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "request_confirmation",
      continuationPolicy: "none",
      idempotencyKey: "confirmation:PAP-1135:plan:33333333-3333-4333-8333-333333333333",
      title: "Plan approval",
      payload: {
        version: 1,
        prompt: "Accept this plan?",
        acceptLabel: "Accept plan",
        allowDeclineReason: true,
        rejectLabel: "Request changes",
        rejectRequiresReason: true,
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 3,
        },
      },
    });
  });

  it("creates approvals with the expected company-scoped payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "approval-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellCreateApproval");
    await tool.execute({
      type: "hire_agent",
      payload: { branch: "pap-1167" },
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/approvals",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "hire_agent",
      payload: { branch: "pap-1167" },
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });
  });

  it("rejects invalid generic request paths", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const tool = getTool("workcellApiRequest");
    const response = await tool.execute({
      method: "GET",
      path: "issues",
    });

    expect(response.content[0]?.text).toContain("path must start with /");
  });

  it("rejects generic request paths that escape /api", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const tool = getTool("workcellApiRequest");
    const response = await tool.execute({
      method: "GET",
      path: "/../../secret",
    });

    expect(response.content[0]?.text).toContain("must not contain '..'");
  });

  // ---------- WC-62: Knowledge Graph inbound tools ----------

  it("workcellGraphNodes GETs the company graph nodes with an optional kind filter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ items: [{ id: "node-1", nodeKind: "issue" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellGraphNodes");
    const response = await tool.execute({ kind: "decision" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/knowledge-graph/nodes?kind=decision",
    );
    expect(init.method).toBe("GET");
    expect(response.content[0]?.text).toContain("node-1");
  });

  it("workcellGraphNodes omits the query string when no kind is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellGraphNodes");
    await tool.execute({});

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/knowledge-graph/nodes",
    );
  });

  it("workcellGraphNeighborhood GETs the 1-hop neighborhood of a node", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ edges: [], neighbors: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellGraphNeighborhood");
    await tool.execute({ nodeId: "66666666-6666-4666-8666-666666666666" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/knowledge-graph/neighborhood/66666666-6666-4666-8666-666666666666",
    );
    expect(init.method).toBe("GET");
  });

  it("workcellGraphNeighborhood rejects a non-uuid nodeId via schema validation", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tool = getTool("workcellGraphNeighborhood");
    const response = await tool.execute({ nodeId: "not-a-uuid" });
    // makeTool routes zod failures through formatErrorResponse (no fetch).
    expect(response.content[0]?.text.toLowerCase()).toContain("uuid");
  });

  it("workcellGraphSyncIssues POSTs the backfill action with the run id header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ processed: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("workcellGraphSyncIssues");
    const response = await tool.execute({});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/knowledge-graph/sync-issues",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Workcell-Run-Id"]).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
    expect(response.content[0]?.text).toContain("processed");
  });

  // ---------- WC-181 (slice 4): per-agent memory self-manage tools ----------

  it("memory_remember POSTs a node to the CALLING agent's own memory scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "node-1", kind: "fact", label: "deploy-target", content: "us-east-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("memory_remember");
    const response = await tool.execute({
      kind: "fact",
      label: "deploy-target",
      content: "us-east-1",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // URL is scoped to the agent id from the client config — never tool input.
    expect(String(url)).toBe(
      "http://localhost:3100/api/agents/22222222-2222-2222-2222-222222222222/memory/nodes",
    );
    expect(init.method).toBe("POST");
    expect(response.content[0]?.text).toContain("node-1");
  });

  it("memory_remember stamps sourceRunId from the run id in context", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "node-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("memory_remember");
    await tool.execute({ kind: "decision", label: "db", content: "use postgres" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "decision",
      label: "db",
      content: "use postgres",
      sourceRunId: "33333333-3333-3333-3333-333333333333",
    });
    // The run id also flows as the provenance header on the write.
    expect((init.headers as Record<string, string>)["X-Workcell-Run-Id"]).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("memory_remember omits sourceRunId when no run id is in context", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "node-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const noRunClient = new WorkcellApiClient({
      apiUrl: "http://localhost:3100/api",
      apiKey: "token-123",
      companyId: "11111111-1111-1111-1111-111111111111",
      agentId: "22222222-2222-2222-2222-222222222222",
      runId: null,
    });
    const tool = createToolDefinitions(noRunClient).find((t) => t.name === "memory_remember")!;
    await tool.execute({ kind: "fact", label: "x", content: "y" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ kind: "fact", label: "x", content: "y" });
  });

  it("memory_recall GETs the calling agent's own graph and returns a compact list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        nodes: [
          { id: "n1", kind: "fact", label: "deploy-target", content: "us-east-1" },
          { id: "n2", kind: "decision", label: "db", content: "postgres" },
        ],
        edges: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("memory_recall");
    const response = await tool.execute({});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/agents/22222222-2222-2222-2222-222222222222/memory",
    );
    expect(init.method).toBe("GET");
    expect(response.content[0]?.text).toContain("deploy-target");
    expect(response.content[0]?.text).toContain("\"count\": 2");
  });

  it("memory_recall filters by kind client-side", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        nodes: [
          { id: "n1", kind: "fact", label: "f", content: "F" },
          { id: "n2", kind: "decision", label: "d", content: "D" },
        ],
        edges: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("memory_recall");
    const response = await tool.execute({ kind: "decision" });
    const parsed = JSON.parse(response.content[0]!.text);
    expect(parsed.count).toBe(1);
    expect(parsed.memories[0].label).toBe("d");
  });

  it("memory_forget DELETEs the calling agent's node by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "node-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("memory_forget");
    await tool.execute({ nodeId: "77777777-7777-4777-8777-777777777777" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/agents/22222222-2222-2222-2222-222222222222/memory/nodes/77777777-7777-4777-8777-777777777777",
    );
    expect(init.method).toBe("DELETE");
  });

  it("memory_forget resolves a node id from (kind,label) before deleting", async () => {
    const fetchMock = vi.fn()
      // first call: recall the graph to resolve the id
      .mockResolvedValueOnce(
        mockJsonResponse({
          nodes: [{ id: "n-stale", kind: "todo", label: "ship-thing", content: "..." }],
          edges: [],
        }),
      )
      // second call: the DELETE
      .mockResolvedValueOnce(mockJsonResponse({ id: "n-stale" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("memory_forget");
    await tool.execute({ kind: "todo", label: "ship-thing" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [recallUrl, recallInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(recallUrl)).toBe(
      "http://localhost:3100/api/agents/22222222-2222-2222-2222-222222222222/memory",
    );
    expect(recallInit.method).toBe("GET");
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(deleteUrl)).toBe(
      "http://localhost:3100/api/agents/22222222-2222-2222-2222-222222222222/memory/nodes/n-stale",
    );
    expect(deleteInit.method).toBe("DELETE");
  });

  it("memory_forget reports a miss when no (kind,label) node exists, without deleting", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockJsonResponse({ nodes: [], edges: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("memory_forget");
    const response = await tool.execute({ kind: "fact", label: "missing" });

    expect(fetchMock).toHaveBeenCalledTimes(1); // recall only, no DELETE
    expect(response.content[0]?.text).toContain("forgotten");
    expect(response.content[0]?.text).toContain("false");
  });

  it("memory_forget rejects input that identifies nothing", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tool = getTool("memory_forget");
    const response = await tool.execute({});
    expect(response.content[0]?.text.toLowerCase()).toContain("nodeid");
  });

  it("memory_link POSTs an edge in the calling agent's own scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "edge-1", relation: "supersedes" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("memory_link");
    await tool.execute({
      fromNodeId: "88888888-8888-4888-8888-888888888888",
      toNodeId: "99999999-9999-4999-8999-999999999999",
      relation: "supersedes",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/agents/22222222-2222-2222-2222-222222222222/memory/edges",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      fromNodeId: "88888888-8888-4888-8888-888888888888",
      toNodeId: "99999999-9999-4999-8999-999999999999",
      relation: "supersedes",
    });
  });

  // ---------- WC-182g (D22): designer-agent design tools ----------

  it("design_attach with html uploads the 시안 as an asset and sends a SHORT asset url (not an inlined data: url)", async () => {
    const contentPath = "/api/assets/abcdef01-2345-6789-abcd-ef0123456789/content";
    const fetchMock = vi
      .fn()
      // 1) the multipart upload to the company's assets endpoint
      .mockResolvedValueOnce(mockJsonResponse({ assetId: "abcdef01-2345-6789-abcd-ef0123456789", contentPath }, 201))
      // 2) the design-artifacts create
      .mockResolvedValueOnce(mockJsonResponse({ id: "wp-1", type: "design", reviewState: "none", isPrimary: true }));
    vi.stubGlobal("fetch", fetchMock);

    const html = "<html><body><h1>로그인 화면</h1></body></html>";
    const tool = getTool("design_attach");
    const response = await tool.execute({
      issueId: "PAP-1135",
      title: "Login screen 시안",
      html,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Call 1: multipart upload to the agent's OWN company assets endpoint.
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(uploadUrl)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/assets/images",
    );
    expect(uploadInit.method).toBe("POST");
    expect(uploadInit.body).toBeInstanceOf(FormData);
    const form = uploadInit.body as FormData;
    expect(form.get("namespace")).toBe("design-sian");
    const filePart = form.get("file");
    expect(filePart).toBeInstanceOf(Blob);
    expect((filePart as Blob).type).toBe("text/html");
    // No manual Content-Type — fetch derives the multipart boundary itself.
    expect((uploadInit.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect((uploadInit.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-123");

    // Call 2: design-artifacts create carries a SHORT absolute asset url.
    const [artifactUrl, artifactInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(artifactUrl)).toBe("http://localhost:3100/api/issues/PAP-1135/design-artifacts");
    expect(artifactInit.method).toBe("POST");
    const body = JSON.parse(String(artifactInit.body));
    expect(body.url).toBe(`http://localhost:3100${contentPath}`);
    expect(body.url.startsWith("data:")).toBe(false);
    expect(body.type).toBe("design");
    expect(body.title).toBe("Login screen 시안");
    expect(body.isPrimary).toBe(true);
    expect((artifactInit.headers as Record<string, string>)["X-Workcell-Run-Id"]).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
    expect(response.content[0]?.text).toContain("wp-1");
  });

  it("design_attach falls back to a self-contained data: url when the asset upload fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      // 1) upload fails (server rejects)
      .mockResolvedValueOnce(mockJsonResponse({ error: "boom" }, 500))
      // 2) design-artifacts create still succeeds
      .mockResolvedValueOnce(mockJsonResponse({ id: "wp-1", type: "design", reviewState: "none", isPrimary: true }));
    vi.stubGlobal("fetch", fetchMock);

    const html = "<html><body><h1>로그인 화면</h1></body></html>";
    const tool = getTool("design_attach");
    await tool.execute({ issueId: "PAP-1135", title: "Login screen 시안", html });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, artifactInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(artifactInit.body));
    // Falls back to the legacy inline data: url (with charset for UTF-8 mockups).
    expect(body.url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(body.url.slice("data:text/html;charset=utf-8,".length))).toBe(html);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("design_attach with a url (no html) passes the external url through unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "wp-2", reviewState: "none" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("design_attach");
    await tool.execute({
      issueId: "PAP-1135",
      title: "External mockup",
      url: "https://figma.com/file/abc",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.url).toBe("https://figma.com/file/abc");
    expect(body.type).toBe("design");
    expect(body.isPrimary).toBe(true);
  });

  it("design_attach with makeAuthoritative:false sends isPrimary false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockJsonResponse({ contentPath: "/api/assets/aaaaaaaa-1111-2222-3333-444444444444/content" }, 201))
      .mockResolvedValueOnce(mockJsonResponse({ id: "wp-3" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("design_attach");
    await tool.execute({
      issueId: "PAP-1135",
      title: "Alternative concept",
      html: "<html></html>",
      makeAuthoritative: false,
    });

    // The design-artifacts create is the LAST call (the upload is first).
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(JSON.parse(String(init.body)).isPrimary).toBe(false);
  });

  it("design_attach honours an explicit design type", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockJsonResponse({ contentPath: "/api/assets/aaaaaaaa-1111-2222-3333-444444444444/content" }, 201))
      .mockResolvedValueOnce(mockJsonResponse({ id: "wp-4" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("design_attach");
    await tool.execute({
      issueId: "PAP-1135",
      title: "Preview",
      html: "<html></html>",
      type: "ui_preview",
    });

    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(JSON.parse(String(init.body)).type).toBe("ui_preview");
  });

  it("design_attach requires either html or url", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tool = getTool("design_attach");
    const response = await tool.execute({ issueId: "PAP-1135", title: "Nothing" });
    expect(response.content[0]?.text.toLowerCase()).toContain("html");
  });

  it("design_submit_for_review POSTs the design-review submit gate for a work product", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "wp-1", reviewState: "needs_board_review", isPrimary: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("design_submit_for_review");
    const response = await tool.execute({
      workProductId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/work-products/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/design-review/submit",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({});
    expect(response.content[0]?.text).toContain("needs_board_review");
  });
});
