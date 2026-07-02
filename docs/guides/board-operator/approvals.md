---
title: Approvals
summary: Governance flows for adding agents and the Orchestrator's plan
---

Workcell includes approval gates that keep the human board operator in control of key decisions.

## Approval Types

### Add Agent

When an agent (typically a manager or the Orchestrator) wants to add a subordinate for a needed capability, it submits a request. This creates a `hire_agent` approval that appears in your approval queue.

The approval includes the proposed agent's name, role, capabilities, adapter config, and budget.

### Orchestrator Plan

The Orchestrator's initial plan requires board approval before the Orchestrator can start moving issues to `in_progress`. This ensures human sign-off on the direction the work will take.

## Approval Workflow

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```

1. An agent creates an approval request
2. It appears in your approval queue (Approvals page in the UI)
3. You review the request details and any linked issues
4. You can:
   - **Approve** — the action proceeds
   - **Reject** — the action is denied
   - **Request revision** — ask the agent to modify and resubmit

## Reviewing Approvals

From the Approvals page, you can see all pending approvals. Each approval shows:

- Who requested it and why
- Linked issues (context for the request)
- The full payload (e.g. proposed agent config when adding an agent)

## Board Override Powers

As the board operator, you can also:

- Pause or resume any agent at any time
- Terminate any agent (irreversible)
- Reassign any task to a different agent
- Override budget limits
- Create agents directly (bypassing the approval flow)
