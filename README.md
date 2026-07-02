# Workcell

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm 9.15+](https://img.shields.io/badge/pnpm-9.15%2B-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Workcell is a multi-agent operations platform specialized for running development
projects: a human board sets the direction, and an AI team — Orchestrator, Developer,
Designer, QA — ships it with proof.**

[English](./README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [Português (BR)](./README.pt-BR.md) · [Русский](./README.ru.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Bahasa Indonesia](./README.id.md) · [Italiano](./README.it.md)

You stay the board: you own direction, approvals, and policy. Agents take on functional
roles, pick up issues, and leave behind both work products and the **proof** that the work
is actually done. The control plane runs the org — projects, issues, budgets, governance,
and an immutable audit trail — while you spend your time on the decisions that matter.

> Operate like a company · execute like issues · design as the source of truth · let humans judge.

---

## Philosophy

Workcell is opinionated about how a development project should run. Four commitments shape
the whole product:

### 1. The human is the board, not a bystander

There is no "zero-human company" here. The human owns direction, approvals, and policy;
agents own execution. Every gate that matters — design approval, proof review, budget,
hiring — terminates at a human decision, recorded in an immutable audit log.

### 2. A development project ships with a real team

Workcell carries **four seats by default — Orchestrator, Designer, Developer, QA.** This is
a deliberate philosophy, not a template: these four are the *smallest* team that can take an
idea from intent to proven — design-first, with a clear owner for every gate.

| Seat | Role | Owns |
| --- | --- | --- |
| **Orchestrator** | routing & coordination | turns natural language into structured issues, routes work to the right role, and watches stuck runs |
| **Designer** | `designer` | the design system — proposes 시안, maintains the approved source-of-truth designs (**design comes first**) |
| **Developer** | `engineer` | implementation, debugging, tests — builds against the *approved* design, never ahead of it |
| **QA** | `qa` | the *Done* verdict — reproduces, verifies, and signs off on proof |

Onboarding seeds the Orchestrator; the Agents page surfaces the missing seats as one-click
hires. The Orchestrator's charter routes code to engineers, UX to designers, and
verification to QA — so the team shape is not just documentation, it is how work flows.

**The four seats are a skeleton, not a ceiling — extend freely on top of them.** Hire
additional functional roles as the work demands — **Lead, PM, Researcher, Writer, Security,
DevOps, or a general-purpose agent** — and equip any agent with scoped skills, plugins, MCP
servers, and design systems from the Capability Registry. Run an issue's owner as a single
agent or — experimental, opt-in — as **dual-brain** (two models generate in parallel, then a
synthesizer merges them). The default keeps a
new project coherent from day one; the org then grows to fit the project — not the reverse.

### 3. The whole app is planned as one blueprint — design is the source of truth

Every project has an **App Blueprint (전체 앱 기획)**: a flow-first, Figma-style view of the
entire app's screens, so the plan and the design live in one place.

![App Blueprint — screens as a flow, each paired with its plan](docs/assets/app-blueprint.svg)

- **Screen + plan, as a pair.** Each screen is a **pure 시안 (the rendered mockup)** joined
  to its **화면 기획 (screen plan)** — the spec for purpose, states, interactions, and data.
  The mockup shows *what* a screen is; the plan describes it. They are authored and move
  together (one screen = one 시안 + one plan).
- **Flow-first.** The blueprint opens on the flow: screen nodes wired together by labelled
  navigation arrows, so the whole app's composition is legible at a glance. Nodes are
  **drag-repositionable with persisted positions**, the canvas zooms at the cursor, and
  clicking a screen opens its **화면 기획** detail — the mockup beside its plan, with that
  screen's incoming/outgoing links spelled out.
- **Design is the source of truth.** For screen-facing work, implementation follows design —
  never the reverse. An issue's primary 시안 passes a review gate (`needs_board_review →
  approved | changes_requested`); until the board approves, agents **hold development**;
  after approval the design is injected as the implementation target. New teams are
  **design-first by default** (non-visual issues opt out per issue with a reason).
- The designer agent authors each screen as the pure 시안 **plus** its plan, and legacy
  designs can be re-authored into the same paired model.

### 4. Done means proven

Borrowing the issueflow discipline, every issue carries acceptance criteria, non-goals,
and a proof surface. An issue **cannot reach *Done* without a proof bundle**, the QA role
owns the verdict, and finishing an issue kicks off a compound learning cycle
(auto-checklist → optional LLM auto-fill → follow-up issues). Knowledge compounds instead
of evaporating.

---

## Forked from Paperclip, rebuilt for development projects

Workcell began as a fork of **Paperclip** (`paperclipai`, MIT-licensed) — a well-built
open-source control plane for orchestrating teams of AI agents: org charts, heartbeats,
budgets, governance, a ticket system, an immutable audit log, and true multi-company
isolation. That control plane is real, solid engineering, and Workcell keeps it as its
foundation. We're grateful for it, and Paperclip's original copyright and MIT permission
notice are preserved in [`NOTICE`](./NOTICE).

We forked because our **product philosophy diverged** — not because anything in Paperclip
was wrong for its own goals. Paperclip frames itself around *zero-human companies*: an
autonomous AI workforce you "hire" into a CEO/CTO org chart and largely step back from.
Workcell takes the opposite stance on the human's role and narrows the aim from "run any
business" to **running development projects well**. That difference runs deep enough to
change the domain model, the UX, and the definition of "done":

- **The CEO-company metaphor → a board + orchestrator + functional-roles model.** The
  human is the **board**; the top agent is an **Orchestrator** that routes and coordinates.
  Agents are functional roles (orchestrator, lead, PM, engineer, designer, researcher,
  writer, QA, security, devops, general), not C-suite titles.
- **Design-first + proof-gated execution discipline.** Design approval gates
  implementation; proof gates *Done*; QA owns the verdict; compound learning closes the
  loop. None of this exists in stock Paperclip — it is the most load-bearing behavioral
  change of the fork.
- **Open Design + Graphify, woven in.** Workcell integrates
  [Open Design](https://github.com/nexu-io/open-design)-style design operations (design
  artifacts, review gates, a design dashboard plugin) and a **Knowledge Graph** fed by the
  **Graphify** code-graph producer — so agents navigate issues, code, decisions, and
  designs as one connected index instead of rediscovering the repo every run.
- **Net-new orchestration subsystems.** A **Capability Registry** (skills / plugins / MCP
  / design systems with scope, visibility, and trust tiers), **dual-brain deliberation**
  (one agent self-reviewing across two models), an outbound **MCP bridge**, and a
  watchdog/recovery layer that folds finished-but-stuck runs instead of filing paperwork.
- **Multi-tenant / i18n productization.** Hardened tenant isolation, full delete-cascade
  audits, first-class internationalization, dark theme by default.

Workcell is an independent fork and is not affiliated with or endorsed by Paperclip.

---

## Key features

- **Natural-language → issue.** Describe a feature on the board and the Orchestrator
  drafts a structured issue with acceptance criteria, non-goals, and a proof surface.
- **Design gate.** Screen-facing issues hold until the board approves a source-of-truth
  design; the approved design becomes the implementation target injected into agent runs.
- **Proof-gated Done + QA signoff.** Issues reach *Done* only with proof evidence; an
  execution policy routes the first "done" into QA review automatically.
- **Knowledge Graph + Graphify.** A pointer-only graph over issues, code, decisions, and
  plans; `workcell code-graph` ingests a Graphify export so code structure joins the graph.
- **App Blueprint (전체 앱 기획).** A flow-first, Figma-style view of every screen in the
  app — pure 시안 paired with a 화면 기획 (screen plan), draggable persisted nodes, cursor
  zoom, labelled navigation arrows, and click-through to each screen's plan. Per project;
  the approved 시안 is the implementation target. (The Open Design plugin still renders
  artifacts, version diffs, and sandboxed previews on a dedicated `/design` page.)
- **Dual-brain deliberation** *(experimental, opt-in)*. One agent, two models: both generate
  a candidate in parallel, then a synthesizer brain merges them into the final answer
  (OpenRouter-Fusion style); live runs are flag-gated (off by default).
- **Bring your own agent.** Claude and Codex local adapters (plus HTTP/process) under one
  org chart.
- **Capability Registry.** Skills, plugins, MCP servers, and design systems assigned at
  company or per-agent scope, with trust tiers, visibility states, and board approval.
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

## Dual-brain deliberation (experimental)

An issue owner can be run as **one agent with two brains** — two independently configured
models — fused **OpenRouter-Fusion style**. Both brains **generate a candidate answer in
parallel and independently** (neither sees the other's draft); then a **synthesizer brain**
(brain A by default) reconciles the two into one stronger final answer — keeping what each got
right, dropping the rest, resolving conflicts. Pick two *different* models and you stack model
diversity on top of the synthesis.

![Dual-brain deliberation](docs/assets/dual-brain.svg)

Why it works: most of the lift comes from the **synthesis step itself**, not just model
diversity. When OpenRouter measured its **Fusion** approach on Perplexity's **DRACO**
deep-research benchmark, pairing **Claude Opus 4.8 with *itself*** as a two-model panel lifted
its score from **58.8% to 65.5%** — because two passes of even the same model diverge, and a
synthesizer that reconciles them beats a single shot.
([write-up](https://datasciencedojo.com/blog/openrouter-fusion-api/), [OpenRouter](https://openrouter.ai/).)

**Status: opt-in, off by default.** The fusion engine — parallel generate + synthesize — is
implemented and tested, but driving it with *real* models is gated behind a flag
(`WORKCELL_PAIR_LIVE_LLM`, so dev/CI never spend by accident) and runs as a dedicated,
pollable agent-deliberation run. See [`docs/FEATURES.md`](./docs/FEATURES.md) for the exact,
flag-by-flag scope.

---

## Architecture (monorepo layout)

Workcell is a pnpm workspace (Node 20+, pnpm 9.15+):

| Path | Package | Role |
| --- | --- | --- |
| `server/` | `@workcell/server` | Express REST API + orchestration services (heartbeat, runs, design gate, governance, audit) |
| `ui/` | `@workcell/ui` | React + Vite board UI (served by the API in dev) |
| `cli/` | `workcell` | CLI / `workcell` binary — onboard, configure, code-graph, cloud sync |
| `packages/shared/` | `@workcell/shared` | Shared types, constants, validators, API path contracts |
| `packages/db/` | `@workcell/db` | Drizzle schema, migrations, DB clients (embedded Postgres in dev) |
| `packages/adapters/` | — | Agent adapters (claude / codex / …) |
| `packages/adapter-utils/` | `@workcell/adapter-utils` | Shared adapter utilities (MCP injection, cost mapping) |
| `packages/mcp-server/` | `@workcell/mcp-server` | Inbound MCP server (Workcell API → tools) |
| `packages/mcp-bridge/` | `@workcell/mcp-bridge` | Outbound MCP client (Workcell → external MCP sidecars) |
| `packages/plugins/` | — | Plugin system, SDK, sandbox providers, example plugins (incl. Open Design dashboard) |

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

First run: the onboarding wizard creates your team (design-first by default), seeds the
**Orchestrator**, and opens your first issue. Then hire the rest of the recommended team —
Engineer, Designer, QA — from the Agents page (one-click per missing seat).

See [`AGENTS.md`](./AGENTS.md) for the contributor workflow and engineering rules.

### Documentation map

| Area | File |
| --- | --- |
| Detailed product specification | [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) |
| Feature inventory (vs Paperclip) | [`docs/FEATURES.md`](./docs/FEATURES.md) |
| Active plan / roadmap / decisions | [`docs/plan/PLAN.md`](./docs/plan/PLAN.md) · [`docs/plan/ROADMAP.md`](./docs/plan/ROADMAP.md) · [`docs/plan/DECISIONS.md`](./docs/plan/DECISIONS.md) |
| Reusable solutions / prevention rules | [`docs/solutions/INDEX.md`](./docs/solutions/INDEX.md) |

---

## License & attribution

Workcell is released under the [MIT License](./LICENSE) (© 2026 Workcell).

Portions of Workcell are derived from **Paperclip** (`paperclipai`), © 2025 Paperclip AI,
also MIT-licensed. As required by the MIT License, Paperclip's original copyright and
permission notice are reproduced in [`NOTICE`](./NOTICE) and must be retained in
redistributions.
