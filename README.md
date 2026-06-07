# Workcell

**Workcell is a general-purpose project-operations platform where a human sets the
direction and a team of AI agents executes it "like a company."**

You stay the board: you own direction, approvals, and policy. Agents take on functional
roles, pick up issues, and leave behind both work products and the **proof** that the work
is actually done. The control plane runs the org — projects, issues, budgets, governance,
and an immutable audit trail — while you spend your time on the decisions that matter.

> Operate like a company · execute like issues · let humans judge.

---

## Forked from Paperclip

Workcell began as a fork of **Paperclip** (`paperclipai`, MIT-licensed) — a well-built
open-source control plane for orchestrating teams of AI agents: org charts, heartbeats,
budgets, governance, a ticket system, an immutable audit log, and true multi-company
isolation. That control plane is real, solid engineering, and Workcell keeps it as its
foundation. We're grateful for it, and Paperclip's original copyright and MIT permission
notice are preserved in [`NOTICE`](./NOTICE).

We forked because our **product philosophy diverged** — not because anything in Paperclip
was wrong for its own goals. Paperclip frames itself around *zero-human companies*: an
autonomous AI workforce you "hire" into a CEO/CTO org chart and largely step back from.
Workcell deliberately takes the opposite stance on the human's role, and that difference
runs deep enough to change the domain model, the UX, and the definition of "done":

- **The CEO-company metaphor → a board + orchestrator + functional-roles model.** The
  human is not a hands-off owner of an autonomous company; the human is the **board** that
  owns direction and approvals. The top agent is reframed from "CEO" to an
  **Orchestrator** that routes and coordinates work. Agents are not C-suite titles
  (CEO/CTO/CMO/CFO) but **functional roles** — orchestrator, lead, PM, engineer, designer,
  researcher, writer, QA, security, devops, general — so the platform fits software,
  content, design, and operations work rather than mimicking a corporate hierarchy.
  *(See the identity arc in [`CURRENT_STATE.md`](./CURRENT_STATE.md), slices WC-70–75.)*

- **Proof-gated execution discipline.** Borrowing the issueflow philosophy, every issue
  carries acceptance criteria, non-goals, and a proof surface. A QA/QC role **cannot mark
  an issue *Done* without a proof bundle**, and finishing an issue kicks off a compound
  learning cycle (auto-checklist → optional LLM auto-fill → follow-up issues). None of
  this exists in stock Paperclip; it is the most load-bearing behavioral change.

- **Net-new orchestration subsystems.** Workcell adds capabilities Paperclip does not
  ship: a **Knowledge Graph** (issues + code + decisions as a navigable index), a
  **Graphify** code-graph producer, a **Capability Registry** (skills / plugins / MCP /
  design systems with scope, visibility, and trust tiers), **Pair** collaboration (a
  bounded two-agent refinement loop inside a *single* issue owner — max rounds, stop
  reasons, per-round diffs and cost), and an outbound **MCP bridge** for calling external
  Model-Context-Protocol servers.

- **Multi-tenant / i18n productization.** The fork hardens multi-tenant isolation
  (cross-tenant read-leak fixes, full delete-cascade FK audits, billing-preserving
  deletes) and adds first-class internationalization — the entire user-facing app is
  wired for i18n, with a configurable plan-report language and a dark theme by default.

The result keeps Paperclip's strengths but is organized around **human-directed,
proof-backed execution** rather than fully autonomous companies. Workcell is an
independent fork and is not affiliated with or endorsed by Paperclip.

---

## Key features

- **Natural-language → issue.** Describe a feature on the board and a Planner/Orchestrator
  drafts a structured issue with acceptance criteria, non-goals, and a proof surface.
- **Single or pair execution.** A `WorkOwner` is `single` or `pair`; pair runs a bounded
  drafter↔critic loop with round diffs, stop reasons, and cost — without breaking the
  one-owner-per-issue invariant.
- **Proof-gated Done.** Issues reach *Done* only with proof evidence; a QA/QC role owns the
  verdict.
- **Bring your own agent.** Claude and Codex local adapters (plus HTTP/process) under one
  org chart.
- **Capability Registry.** Assign skills, plugins, MCP servers, and design systems at
  company or per-agent scope, with trust tiers, visibility states, and board approval.
- **Knowledge Graph + Graphify.** A derived index over issues, code, decisions, and plans,
  consumed by agents via MCP / context injection.
- **MCP bridge (in + out).** An inbound MCP server exposes Workcell's API as tools; an
  outbound MCP client lets Workcell call external sidecars (capability-gated, tenant-scoped).
- **Cost control & governance.** Per-agent budgets with hard stops, a Usage Center with
  `Exact / Synced / Estimated` accuracy badges, board approval gates, and an immutable,
  company-scoped audit log.
- **Multi-company isolation & i18n.** One deployment, many fully isolated companies;
  user-facing UI internationalized; dark theme by default.

A detailed, always-current feature inventory (with `[Paperclip]` / `[Changed]` / `[New]`
tags) lives in [`docs/FEATURES.md`](./docs/FEATURES.md).

---

## Architecture (monorepo layout)

Workcell is a pnpm workspace (Node 20+, pnpm 9.15+):

| Path | Package | Role |
| --- | --- | --- |
| `server/` | `@workcell/server` | Express REST API + orchestration services (heartbeat, runs, pair, governance, audit) |
| `ui/` | `@workcell/ui` | React + Vite board UI (served by the API in dev) |
| `cli/` | `workcell` | CLI / `workcell` binary — onboard, configure, code-graph, cloud sync |
| `packages/shared/` | `@workcell/shared` | Shared types, constants, validators, API path contracts |
| `packages/db/` | `@workcell/db` | Drizzle schema, migrations, DB clients (embedded Postgres in dev) |
| `packages/adapters/` | — | Agent adapters (claude / codex / …) |
| `packages/adapter-utils/` | `@workcell/adapter-utils` | Shared adapter utilities (MCP injection, cost mapping) |
| `packages/mcp-server/` | `@workcell/mcp-server` | Inbound MCP server (Workcell API → tools) |
| `packages/mcp-bridge/` | `@workcell/mcp-bridge` | Outbound MCP client (Workcell → external MCP sidecars) |
| `packages/plugins/` | — | Plugin system, SDK, sandbox providers, example plugins |

A single Node process runs the API, an embedded PostgreSQL, and local file storage in
development; in production you point it at your own Postgres.

---

## Getting started

Requirements: **Node.js 20+**, **pnpm 9.15+**.

```bash
pnpm install
pnpm dev          # API + UI in watch mode
```

An embedded PostgreSQL database is created automatically in development — leave
`DATABASE_URL` unset to use it. Common scripts (from `package.json`):

```bash
pnpm dev          # full dev (API + UI, watch)
pnpm dev:server   # server only
pnpm typecheck    # workspace-wide type check
pnpm test         # stable Vitest run (does NOT run Playwright)
pnpm build        # build all packages
pnpm test:e2e     # Playwright browser suite (opt-in)
pnpm db:generate  # generate a DB migration
pnpm db:migrate   # apply migrations
```

See [`AGENTS.md`](./AGENTS.md) for the contributor workflow and engineering rules.

### Documentation map

| Area | File |
| --- | --- |
| Core product promise & non-negotiable goals | [`PLAN_ANCHOR.md`](./PLAN_ANCHOR.md) |
| Original detailed specification | [`기본 기획서.md`](./기본%20기획서.md) |
| Feature inventory (vs Paperclip) | [`docs/FEATURES.md`](./docs/FEATURES.md) |
| Current state, recent proof, next actions | [`CURRENT_STATE.md`](./CURRENT_STATE.md) |
| Active plan / roadmap / decisions | [`docs/plan/PLAN.md`](./docs/plan/PLAN.md) · [`docs/plan/ROADMAP.md`](./docs/plan/ROADMAP.md) · [`docs/plan/DECISIONS.md`](./docs/plan/DECISIONS.md) |
| Reusable solutions / prevention rules | [`docs/solutions/INDEX.md`](./docs/solutions/INDEX.md) |

---

## License & attribution

Workcell is released under the [MIT License](./LICENSE) (© 2026 Workcell).

Portions of Workcell are derived from **Paperclip** (`paperclipai`), © 2025 Paperclip AI,
also MIT-licensed. As required by the MIT License, Paperclip's original copyright and
permission notice are reproduced in [`NOTICE`](./NOTICE) and must be retained in
redistributions.
