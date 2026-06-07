<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="#features"><strong>Features</strong></a> &middot;
  <a href="#why-workcell-is-special"><strong>Why Workcell</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
</p>

<br/>

## What is Workcell?

# Human-directed orchestration for AI agent teams

**You set the direction; a team of AI agents executes it "like a company."**

Workcell is a Node.js server and React UI that orchestrates a team of AI agents to run your
projects. You stay the **board** — you own direction and approvals — while agents take on
functional roles, pick up issues, and leave behind both work products and the **proof** that
the work is actually done.

It looks like a task manager — but under the hood it has org charts, budgets, governance, a
knowledge graph, capability management, and proof-gated execution.

**Manage direction and proof, not pull requests.**

|        | Step              | Example                                                              |
| ------ | ----------------- | ------------------------------------------------------------------- |
| **01** | Set the direction | _"Ship a polished AI note-taking app — define the first milestone."_ |
| **02** | Staff the roles   | Orchestrator, engineers, designers, QA — any agent, any provider.   |
| **03** | Approve and run   | Review the plan. Set budgets. Hit go. Monitor — and judge the proof. |

> Workcell is a fork of [Paperclip](#forked-from-paperclip) (`paperclipai`, MIT). It keeps
> Paperclip's control plane but reorients it around **human-directed, proof-backed
> execution** instead of fully autonomous companies.

<br/>

## Workcell is right for you if

- ✅ You want to **direct a team of AI agents** like a company — and stay in the loop
- ✅ You **coordinate many different agents** (Claude, Codex, …) toward a common goal
- ✅ You have **many agent terminals** open and lose track of what everyone is doing
- ✅ You want agents working on a schedule, but still want to **audit work and chime in**
- ✅ You want a **proof trail** — nothing is "done" until the evidence says so
- ✅ You want to **monitor costs** and enforce budgets
- ✅ You want a process for managing agents that **feels like using a task manager**

<br/>

## Features

<table>
<tr>
<td align="center" width="33%">
<h3>🔌 Bring Your Own Agent</h3>
Claude and Codex local adapters (plus HTTP/process), all under one org chart.
</td>
<td align="center" width="33%">
<h3>🎯 Goal Alignment</h3>
Every issue traces back to the mission. Agents know <em>what</em> to do and <em>why</em>.
</td>
<td align="center" width="33%">
<h3>💓 Heartbeats</h3>
Agents wake on a schedule, check work, and act. Delegation flows up and down the org chart.
</td>
</tr>
<tr>
<td align="center">
<h3>✅ Proof-gated Done</h3>
An issue can't reach <em>Done</em> without a proof bundle. A QA/QC role owns the verdict.
</td>
<td align="center">
<h3>👥 Pair Collaboration</h3>
A bounded two-agent drafter↔critic loop inside one issue owner — rounds, stop reasons, cost.
</td>
<td align="center">
<h3>🧩 Capability Registry</h3>
Assign skills, plugins, MCP servers, and design systems per company or per agent, with trust tiers.
</td>
</tr>
<tr>
<td align="center">
<h3>🕸️ Knowledge Graph</h3>
A derived index over issues, code, and decisions — consumed by agents via MCP and context injection.
</td>
<td align="center">
<h3>💰 Cost Control</h3>
Monthly budgets per agent. When they hit the limit, they stop. No runaway costs.
</td>
<td align="center">
<h3>🏢 Multi-Company</h3>
One deployment, many companies. Complete data isolation. One control plane for your portfolio.
</td>
</tr>
<tr>
<td align="center">
<h3>🎫 Ticket System</h3>
Every conversation traced. Every decision explained. Full tool-call tracing and immutable audit log.
</td>
<td align="center">
<h3>🛡️ Governance</h3>
You're the board. Approve capabilities and strategy, override decisions, pause or stop any agent.
</td>
<td align="center">
<h3>🌐 Internationalized</h3>
The whole UI is wired for i18n (verified Korean + English), with a configurable plan-report language.
</td>
</tr>
</table>

<br/>

## Why Workcell is special

Workcell handles the hard orchestration details correctly.

|                                   |                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Atomic execution.**             | Task checkout and budget enforcement are atomic, so no double-work and no runaway spend.                      |
| **Proof-gated execution.**        | Issues carry acceptance criteria, non-goals, and a proof surface; a QA/QC role gates <em>Done</em>.           |
| **Persistent agent state.**       | Agents resume the same task context across heartbeats instead of restarting from scratch.                     |
| **Governance with rollback.**     | Approval gates are enforced, config changes are revisioned, and bad changes can be rolled back safely.        |
| **Capability extension via MCP.** | Capabilities are injected through outbound MCP clients — capability-gated, tenant-scoped, re-gated per call.   |
| **Portable company templates.**   | Export/import orgs, agents, and skills with secret scrubbing and collision handling.                          |
| **True multi-company isolation.** | Every entity is company-scoped, so one deployment can run many companies with separate data and audit trails. |

<br/>

## What Workcell is not

|                              |                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Not a chatbot.**           | Agents have jobs, not chat windows.                                                                                  |
| **Not an agent framework.**  | We don't tell you how to build agents. We tell you how to run a team of them.                                        |
| **Not a workflow builder.**  | No drag-and-drop pipelines. Workcell models organizations — with org charts, goals, budgets, and governance.        |
| **Not a "set it and forget it" autopilot.** | The human stays the board: you own direction, approvals, and the final judgment on proof.             |
| **Not a single-agent tool.** | This is for teams. If you have one agent, you probably don't need Workcell. If you have many — you do.               |

<br/>

## Quickstart

Open source. Self-hosted. No account required.

```bash
npx workcell onboard --yes
```

That quickstart path defaults to trusted local loopback mode for the fastest first run. To
start in authenticated/private mode instead, choose a bind preset explicitly:

```bash
npx workcell onboard --yes --bind lan
# or:
npx workcell onboard --yes --bind tailnet
```

If you already have Workcell configured, rerunning `onboard` keeps the existing config in
place. Use `workcell configure` to edit settings.

Or manually:

```bash
pnpm install
pnpm dev
```

This starts the API server at `http://localhost:3100`. An embedded PostgreSQL database is
created automatically — no setup required.

> **Requirements:** Node.js 20+, pnpm 9.15+

<br/>

## FAQ

**What does a typical setup look like?**
Locally, a single Node.js process manages an embedded Postgres and local file storage. For
production, point it at your own Postgres and deploy however you like. Configure projects,
agents, and goals — then direct the work and review the proof.

**Can I run multiple companies?**
Yes. A single deployment can run an unlimited number of companies with complete data isolation.

**How is Workcell different from agents like Claude Code or Codex?**
Workcell _uses_ those agents. It orchestrates them into a team — with org charts, budgets,
goals, governance, proof-gated Done, and accountability.

**Do agents run continuously?**
By default, agents run on scheduled heartbeats and event-based triggers (task assignment,
@-mentions). You bring your agent and Workcell coordinates.

<br/>

## Workcell Cloud Sync

Cloud upstream sync is behind the `Cloud Sync` experimental setting. Enable it in Instance
Settings before pushing.

```bash
workcell cloud connect https://your-stack.example
workcell cloud push --company <local-company-id> --dry-run
workcell cloud push --company <local-company-id>
```

`cloud connect` authorizes the local instance against the target stack and stores the upstream
token in the local instance secret store. `cloud push --dry-run` exports the selected local
company, sends a preview bundle, and exits with code `2` when conflicts need resolution (code
`3` on schema mismatch). Running without `--dry-run` stages chunks idempotently, applies the
run, and prints the summary.

## Development

```bash
pnpm dev              # Full dev (API + UI, watch mode)
pnpm dev:once         # Full dev without file watching
pnpm dev:server       # Server only
pnpm build            # Build all
pnpm typecheck        # Type checking
pnpm test             # Stable test run (Vitest only)
pnpm test:e2e         # Playwright browser suite
pnpm db:generate      # Generate DB migration
pnpm db:migrate       # Apply migrations
```

`pnpm test` does not run Playwright. Browser suites stay separate.

<br/>

## Roadmap

- ✅ Plugin system (knowledge base, custom tracing, queues, …)
- ✅ Bring-your-own agents (Claude, Codex, HTTP/process)
- ✅ Company import/export (org templates)
- ✅ Easy AGENTS.md configurations
- ✅ Skills / Capability Registry
- ✅ Scheduled Routines
- ✅ Budgets + Usage Center
- ✅ Knowledge Graph + Graphify code-graph
- ✅ Pair collaboration (bounded two-agent loop)
- ✅ App-wide internationalization
- ⚪ Live pair file-editing graduation (currently flag-gated)
- ⚪ Real Open Design / Graphify runtime sidecars
- ⚪ Cloud / sandbox agents and deployments

<br/>

## Forked from Paperclip

Workcell began as a fork of **Paperclip** (`paperclipai`, MIT-licensed) and keeps its control
plane — heartbeats, budgets, org charts, governance, ticketing, immutable audit log, and
multi-company isolation. Workcell reorients that foundation around a **board + orchestrator +
functional-roles** model with **proof-gated execution**, and adds net-new subsystems (Knowledge
Graph, Graphify, Capability Registry, Pair collaboration, an outbound MCP bridge, and full
i18n). Paperclip's original copyright and MIT permission notice are preserved in the repo's
`NOTICE` file; Workcell is an independent fork and is not affiliated with or endorsed by
Paperclip. See the repository `README.md` for the full fork rationale.

## License

MIT &copy; 2026 Workcell
