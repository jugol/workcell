---
title: How Delegation Works
summary: How the Orchestrator turns the board's direction into well-formed issues and routes them to the right roles
---

Delegation is one of Workcell's most powerful features. You, as the board, set company goals and own the direction. The Orchestrator agent turns that direction into well-formed issues and routes them to the right roles. This guide explains the full lifecycle from your perspective as the board operator.

## The Delegation Lifecycle

When you set a company goal, the Orchestrator doesn't just acknowledge it — it builds a plan and mobilizes the team:

```
You set a company goal (direction)
  → Orchestrator wakes up on heartbeat
  → Orchestrator proposes a plan (creates an approval for you)
  → You approve the plan
  → Orchestrator breaks goals into well-formed issues and routes them to roles
  → Assigned agents wake up (heartbeat triggered by assignment)
  → Agents execute work and update issue status
  → Orchestrator monitors progress, unblocks, and escalates
  → You see results in the dashboard and activity log
```

Each step is traceable. Every issue links back to the goal through a parent hierarchy, so you can always see why work is happening.

## What You Need to Do

Your role is direction, approvals, and policy — not task management. Here's what the delegation model expects from you:

1. **Set clear company goals.** The Orchestrator works from these. Specific, measurable goals produce better delegation. "Build a landing page" is okay; "Ship a landing page with signup form by Friday" is better.

2. **Approve the Orchestrator's plan.** After reviewing your direction, the Orchestrator submits a plan to the approval queue. Review it, then approve, reject, or request revisions.

3. **Approve requests to add an agent.** When the team lacks a capability the goal needs (e.g., a frontend engineer to build the landing page), the Orchestrator requests to add an agent for that role. You review the proposed agent's role, capabilities, and budget before approving.

4. **Monitor progress.** Use the dashboard and activity log to track how work is flowing. Check issue status, agent activity, and completion rates.

5. **Intervene only when things stall.** If progress stops, check these in order:
   - Is an approval pending in your queue?
   - Is an agent paused or in an error state?
   - Is the Orchestrator's budget exhausted (above 80%, it focuses on critical work only)?

## What the Orchestrator Does Automatically

You do **not** need to tell the Orchestrator which agents to engage. After you approve its plan, the Orchestrator:

- **Breaks goals into well-formed issues** with clear descriptions, priorities, acceptance criteria, non-goals, and a proof surface
- **Routes each issue to the right role** based on capabilities — code, features, infra, and bugs go to an engineer (or a lead for senior or escalation work); UX and UI work goes to a designer; testing, review, and proof go to qa; investigation goes to a researcher; content and writing go to a writer; planning and coordination go to a pm or the Orchestrator
- **Creates sub-issues** when work needs to be decomposed further
- **Adds an agent for a needed capability** when the team can't cover a goal, with board approval available when you enable it in company settings
- **Monitors progress** on each heartbeat, checking issue status and unblocking assigned agents
- **Escalates to you** when it encounters something it can't resolve — budget issues, blocked approvals, or ambiguous direction

## Common Delegation Patterns

### Flat Hierarchy (Small Teams)

For small companies with 3-5 agents, the Orchestrator delegates directly to each report:

```
Orchestrator
 ├── Engineer    (code, features, infra, bugs)
 ├── Writer      (content and marketing copy)
 └── Designer    (UX and UI work)
```

The Orchestrator routes issues directly. Each agent works independently and reports status back.

### Three-Level Hierarchy (Larger Teams)

For larger organizations, leads delegate further down the chain:

```
Orchestrator
 ├── Lead (engineering)
 │    ├── Backend Engineer
 │    └── Frontend Engineer
 └── PM
      └── Writer
```

The Orchestrator routes high-level issues to the engineering lead and the pm. They break those into sub-issues and route them to their own reports. You only interact with the Orchestrator — the rest happens automatically.

### Add-an-Agent-on-Demand

The Orchestrator can start as the only agent and add roles as the work requires:

1. You set a goal that needs engineering work
2. The Orchestrator proposes a plan that includes adding an engineering lead
3. You approve adding the agent
4. The Orchestrator routes engineering issues to the new lead
5. As scope grows, the lead may request to add engineers for the extra capacity

This pattern lets you start small and grow the team based on actual work, not upfront planning.

## Troubleshooting

### "Why isn't the Orchestrator delegating?"

If you've set a goal but nothing is happening, check these common causes:

| Check | What to look for |
|-------|-----------------|
| **Approval queue** | The Orchestrator may have submitted a plan or a request to add an agent that's waiting for your approval. This is the most common reason. |
| **Agent status** | If all reports are paused, terminated, or in an error state, the Orchestrator has no one to route work to. Check the Agents page. |
| **Budget** | If the Orchestrator is above 80% of its monthly budget, it focuses only on critical work and may skip lower-priority delegation. |
| **Goals** | If no company goals are set, the Orchestrator has nothing to work from. Create a goal first. |
| **Heartbeat** | Is the Orchestrator's heartbeat enabled and running? Check the agent detail page for recent heartbeat history. |
| **Agent instructions** | The Orchestrator's delegation behavior is driven by its `AGENTS.md` instructions file. Open the Orchestrator agent's detail page and verify that its instructions path is set and that the file includes delegation directives (sub-issue creation, adding agents, routing by role). If AGENTS.md is missing or doesn't mention delegation, the Orchestrator won't know to break down goals and route work. |

### "Do I have to tell the Orchestrator which roles to engage?"

**No.** The Orchestrator will delegate automatically after you approve its plan. It knows the org chart and routes issues based on each agent's role and capabilities. You set the direction and approve the plan — the Orchestrator handles the issue breakdown and routing.

### "An issue seems stuck"

If a specific issue isn't progressing:

1. Check the issue's comment thread — the assigned agent may have posted a blocker
2. Check if the issue is in `blocked` status — read the blocker comment to understand why
3. Check the assigned agent's status — it may be paused or over budget
4. If the agent is stuck, you can reassign the issue or add a comment with guidance
