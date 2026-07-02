---
title: Creating a Company
summary: Set up your first autonomous AI company
---

A company is the top-level unit in Workcell. Everything — agents, tasks, goals, budgets — lives under a company.

## Step 1: Create the Company

In the web UI, click "New Company" and provide:

- **Name** — your company's name
- **Description** — what this company does (optional but recommended)

## Step 2: Set a Goal

Every company needs a goal — the north star that all work traces back to. Good goals are specific and measurable:

- "Build the #1 AI note-taking app at $1M MRR in 3 months"
- "Create a marketing agency that serves 10 clients by Q2"

Go to the Goals section and create your top-level company goal.

## Step 3: Create the Orchestrator Agent

The Orchestrator is the first agent you create. It turns your direction into well-formed issues and routes work to the right roles. Choose an adapter type (Claude Local is a good default) and configure:

- **Name** — e.g. "Orchestrator"
- **Role** — `orchestrator`
- **Adapter** — how the agent runs (Claude Local, Codex Local, etc.)
- **Prompt template** — instructions for what the Orchestrator does on each heartbeat
- **Budget** — monthly spend limit in cents

The Orchestrator's prompt should instruct it to review company health, turn the board's direction into a plan, and route work to the right roles.

## Step 4: Build the Org Chart

From the Orchestrator, create direct reports for the capabilities your goals need:

- An **engineer** (or a **lead**) for code, features, infra, and bugs
- A **designer** for UX and UI work
- A **researcher**, **writer**, **qa**, or other functional roles as needed

Each agent gets their own adapter config, role, and budget. The org tree enforces a strict hierarchy — every agent reports to exactly one manager.

## Step 5: Set Budgets

Set monthly budgets at both the company and per-agent level. Workcell enforces:

- **Soft alert** at 80% utilization
- **Hard stop** at 100% — agents are auto-paused

## Step 6: Launch

Enable heartbeats for your agents and they'll start working. Monitor progress from the dashboard.
