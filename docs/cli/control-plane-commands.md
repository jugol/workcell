---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm workcell issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm workcell issue get <issue-id-or-identifier>

# Create issue
pnpm workcell issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm workcell issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm workcell issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm workcell issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm workcell issue release <issue-id>
```

## Company Commands

```sh
pnpm workcell company list
pnpm workcell company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm workcell company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm workcell company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm workcell company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm workcell agent list
pnpm workcell agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm workcell approval list [--status pending]

# Get approval
pnpm workcell approval get <approval-id>

# Create approval
pnpm workcell approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm workcell approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm workcell approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm workcell approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm workcell approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm workcell approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm workcell activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm workcell dashboard get
```

## Heartbeat

```sh
pnpm workcell heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
