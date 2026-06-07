# Workcell MCP Server

Model Context Protocol server for Workcell.

This package is a thin MCP wrapper over the existing Workcell REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `WORKCELL_API_URL` - Workcell base URL, for example `http://localhost:3100`
- `WORKCELL_API_KEY` - bearer token used for `/api` requests
- `WORKCELL_COMPANY_ID` - optional default company for company-scoped tools
- `WORKCELL_AGENT_ID` - optional default agent for checkout helpers
- `WORKCELL_RUN_ID` - optional run id forwarded on mutating requests

## Usage

```sh
npx -y @workcell/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @workcell/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Read tools:

- `workcellMe`
- `workcellInboxLite`
- `workcellListAgents`
- `workcellGetAgent`
- `workcellListIssues`
- `workcellGetIssue`
- `workcellGetHeartbeatContext`
- `workcellListComments`
- `workcellGetComment`
- `workcellListIssueApprovals`
- `workcellListDocuments`
- `workcellGetDocument`
- `workcellListDocumentRevisions`
- `workcellListProjects`
- `workcellGetProject`
- `workcellGetIssueWorkspaceRuntime`
- `workcellWaitForIssueWorkspaceService`
- `workcellListGoals`
- `workcellGetGoal`
- `workcellListApprovals`
- `workcellGetApproval`
- `workcellGetApprovalIssues`
- `workcellListApprovalComments`

Write tools:

- `workcellCreateIssue`
- `workcellUpdateIssue`
- `workcellCheckoutIssue`
- `workcellReleaseIssue`
- `workcellAddComment`
- `workcellSuggestTasks`
- `workcellAskUserQuestions`
- `workcellRequestConfirmation`
- `workcellUpsertIssueDocument`
- `workcellRestoreIssueDocumentRevision`
- `workcellControlIssueWorkspaceServices`
- `workcellCreateApproval`
- `workcellLinkIssueApproval`
- `workcellUnlinkIssueApproval`
- `workcellApprovalDecision`
- `workcellAddApprovalComment`

Escape hatch:

- `workcellApiRequest`

`workcellApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
