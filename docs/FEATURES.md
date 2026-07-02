# Workcell — Feature Inventory

> A truthful, cross-checked inventory of functioning features in **Workcell**, a fork of
> **Paperclip** (an AI-agent orchestration platform). Sources: `docs/plan/PLAN.md` §9
> (status-annotated acceptance criteria), `docs/plan/DECISIONS.md` (D1–D21),
> `PRODUCT_SPEC.md` (product spec),
> `docs/plan/STRIP_PLAN.md`, and direct survey of `ui/src/pages/*`, `server/src/routes/*`,
> `server/src/services/*`, `packages/*`.
>
> **Tags:** `[Paperclip]` = inherited largely as-is · `[Changed]` = significantly reworked
> from Paperclip · `[New]` = net-new in Workcell.
>
> **Status markers** (where relevant): ✅ user-visible & working · 🟡 partial / backend-only ·
> ⚑ flag-gated experimental (default OFF).

---

## 1. Issues & Kanban

| Feature | Description | Tag |
|---|---|---|
| Issue CRUD + tree (sub-issues, parent/child) | Core ticket entity with hierarchy, depth control, parent links. | [Paperclip] |
| Kanban board | Operational board view with status columns, drag, filters. | [Paperclip] |
| Issue status model (7-state) | `backlog, todo, in_progress, in_review, done, blocked, cancelled`. | [Paperclip] |
| Issue priorities / work modes | `critical/high/medium/low`; `standard` vs `planning` work mode (gates several Workcell behaviors). | [Paperclip] (work-mode usage extended) |
| Owner-role chip on cards/rows | Assignee agent's functional-role label on Kanban cards + IssuesList. WC-8/10. | [New] |
| Proof-status chip | Green "has proof" badge when a proof bundle is attached (positive-only). WC-9/10. | [New] |
| Usage/cost chip | Per-issue rolled-up cost badge via batched `sumCostCentsByIssueIds`. WC-11. | [New] |
| Pair-mode chip | Indicates `workOwnerKind === "pair"`. WC-34. | [New] |
| Compound-followup lineage chip | Badge on issues spawned by "Process follow-ups" (`originKind=compound_followup`). WC-18. | [New] |
| First-run empty-state guidance | Coachmarks on empty /issues + first issue. WC-96/98. | [New] |
| Comments, threads, read-states, inbox, mentions | Threaded discussion, @-mentions, inbox/dismissals, activity events. | [Paperclip] |
| Search (trigram) | `company-search` (trigram, no embeddings) + rate limiting. | [Paperclip] |

> Note: PLAN §3 specs a 10-state model (adds Draft/Ready/In QA/Blocked-by-User/Archived). The running enum is the 7-state set — the expanded model is **spec-only, not yet implemented**.

## 2. Planner (natural-language → issue drafts)

| Feature | Description | Tag |
|---|---|---|
| Draft-from-prompt | `POST .../issues/draft-from-prompt` → creates a `planning` issue assigned to a Planner-capable agent; a run writes an `issue-draft` doc with acceptance criteria / non-goals / proof / owner-role. PLAN §9 #2 ✅. WC-2. | [New] |
| Planner runs regardless of ongoing work | Planning does not stop because other agents are busy (core philosophy). | [New] |
| Plan-report language preference | Per-company `plan_report_language` (16 curated languages); Planner writes section bodies in chosen language, English headings preserved; settable at onboarding (WC-81) + company settings (WC-89); round-trips via export (WC-90). | [New] |
| Always-visible draft affordance | Sparkles icon + helper line on the /issues natural-language bar. WC-98. | [New] |

## 3. Proof-gated Done & QA signoff

| Feature | Description | Tag |
|---|---|---|
| Proof-gated Done | `→done` returns 409 `proof_required` unless an `issue_work_products` row of `type:"proof"` exists. Gated in service + early at PATCH route. Exemptions: `planning` work-mode + recovery-origin; create-as-done intentionally not gated. PLAN §9 #6 ✅. WC-3/7. | [New] |
| Proof-of-work directive injection | Run prompts for non-planning issues inject a directive to attach a proof bundle. WC-4. | [New] |
| Default QA-review signoff auto-injection | On create (WC-5) + assignment (WC-6), execution issues with an eligible QA agent get a default review-stage policy; executor `done` routes to `in_review`, QA approval completes. | [Changed] |
| Execution-policy signoff machine | review→approval stages, designated reviewers, mandatory comments, non-participant rejection. | [Paperclip] |

## 4. Compound learning / checklists (D19)

| Feature | Description | Tag |
|---|---|---|
| Auto-generated compound checklist | On Done, auto-creates a `compound-checklist` doc (changes / reusable learnings / prevention rules / failed approaches / follow-ups). Idempotent. PLAN §9 #11 ✅. WC-12. | [New] |
| Follow-up bullets → backlog issues | `POST .../compound-followups/process` parses section-5 bullets into real `backlog` child issues (`originKind=compound_followup`); idempotent dedup. UI menu WC-14. WC-13. | [New] |
| LLM-driven checklist auto-fill | `POST .../compound-checklist/auto-fill` delegates to a Planner agent to fill sections 1–4, preserving section 5 verbatim. In-flight banner WC-22. WC-19. | [New] |
| Auto-trigger on Done | Mark-done best-effort triggers auto-fill; no-planner = silent no-op. WC-21. | [New] |

## 5. Agents & Orchestration

| Feature | Description | Tag |
|---|---|---|
| Functional role taxonomy | `orchestrator, lead, pm, engineer, designer, researcher, writer, qa, security, devops, general` — **replaces Paperclip's C-suite (ceo/cto/cmo/cfo)**. The `ceo` key remains an internal auth-root primitive aliased to "Orchestrator"; the role *value* migrated (migration 0099). WC-72. | [Changed] |
| BYO-agent adapters | Built-in: `process, http, claude_local, codex_local` (cursor/gemini/opencode/pi/openclaw remain enum-only; ACPX & grok removed). | [Changed] |
| Adapter "Default" model behavior | Empty model = adapter omits `--model` so the local CLI uses its own default; model field is free-text. WC-77/79. | [Changed] |
| Heartbeat scheduler / liveness | wakeup→queue→claim→execute + reconciler/watchdog — the strongest reused subsystem. | [Paperclip] |
| Run orchestration / transcripts | Run lifecycle, logs, continuations, recovery actions. | [Paperclip] |
| Org chart | Reporting hierarchy + SVG export; crown icon retained for orchestrator root. | [Paperclip] (re-labeled) |
| Reframed default personas | Orchestrator persona bundles rewritten: board owns direction/approval, proof discipline, one-issue-one-owner, functional-role routing — P&L / hire-fire / C-suite removed. WC-71/72. | [Changed] |
| Context compaction (rolling) | Session/anchor rolling maintenance. PLAN §9 #9 ✅ for rolling. | [Paperclip] |
| On-demand context compaction | `POST` compaction route + "Compact context" button on IssueDetail. WC-37/43. | [New] |

> Note: D5 specs a 4-plane context model (Role Charter / Working / Episodic / Capability Index); current compaction is session-rotation + adapter token-window delegation — the full 4-plane design is spec-only.

## 6. Pair collaboration (2-model)

| Feature | Description | Tag |
|---|---|---|
| WorkOwner = single \| pair | `work_owner_kind` column; issue assignee stays single, owner can be a pair. WC-23. | [New] |
| PairGroup data model + CRUD | `pair_groups` table + `pairGroupService` (create flips workOwnerKind; status transitions). WC-24. | [New] |
| PairTurn ledger | `pair_turns` (unique group/round/actor); records turns, advances rounds, auto-stop (abort / max-rounds / convergence). Concurrency-hardened (`onConflictDoNothing`, WC-128). WC-25. | [New] |
| Pair REST routes + orchestrator | GET/POST pair-group, turns, advance, run-round, run-until-stop; round cap pre-check; stop policy. WC-26/32/33/52. | [New] |
| Pair setup UI + timeline | `PairSetupPanel` CTA + `PairRoundTimeline` (Live/Simulated badge, total cost, humanized stop reason, run-to-convergence). WC-78/126/127. | [New] |
| Real LLM pair invoker ⚑ | Real adapter single-turn per round with model parity (WC-97) + env-secret resolution (WC-125). Flag `WORKCELL_PAIR_LIVE_LLM` (default OFF → stub for hermetic CI). WC-58. | [New, flag-gated] |
| Pair file-edit workspace (D21) ⚑ | Live pairs reuse-or-realize an **isolated git worktree** so both agents edit files; tagged worktrees reaped on completion. Flag `WORKCELL_PAIR_LIVE_WORKSPACE` (default OFF). Heartbeat lease/JWT untouched. WC-130–133. | [New, flag-gated] |

## 7. Capability Registry

| Feature | Description | Tag |
|---|---|---|
| Capabilities + assignments | `capabilities` (unique company/key/version) + `capability_assignments` (company-wide when agentId null, else agent-specific). Idempotent register. WC-27. | [New] |
| Trust tiers | `trusted / reviewed / unreviewed` → active vs pending_approval. WC-27. | [New] |
| Visibility | `default / hidden / deprecated`; visibility-aware effective listing per agent. WC-45. | [New] |
| HTTP routes + board authz | All `assertBoard`-gated; grant attribution derived from request actor (forgery-proof). WC-30/51. | [New] |
| Capabilities UI page | Registry page + assignment-approval action + nav. PLAN §9 #7 ✅. WC-35/36/38. | [New] |
| Uniqueness NULLS-NOT-DISTINCT + scope reactivation | migration 0097; assign() reactivates revoked scopes in place. WC-53. | [New] |

## 8. Knowledge Graph (D12) + Code Graph / Graphify (D20)

| Feature | Description | Tag |
|---|---|---|
| Graph nodes/edges (Postgres-native) | `graph_nodes` + `graph_edges`, pointer-only (no content duplication), no AGE/pgvector. 8 node kinds, 6 edge kinds. WC-28. | [New] |
| `knowledgeGraphService` | Idempotent atomic upsert + 1-hop `neighborhood()`. Tenant-scoped (WC-54). WC-28. | [New] |
| Issue populator + routes | Issue-as-node sync + neighborhood routes; updated on issue create/complete. WC-39. | [New] |
| MCP graph tools (inbound) | `workcellGraphNodes / Neighborhood / SyncIssues` via `packages/mcp-server`. WC-62. | [New] |
| Outbound MCP enrichment ⚑ | `neighborhood(?enriched=true)` overlays a `graph-enrichment` MCP call; graceful fallback. WC-63. | [New, capability-gated] |
| KG viewer UI (S5) | `KnowledgeGraphPanel` on IssueDetail — read-only 1-hop neighbors. WC-123. | [New] |
| Code-graph ingest | `ingestCodeGraph` neutral contract; code-semantic edge aliases. WC-107. | [New] |
| Graphify integration (D20) | `mapGraphifyGraphToImport` maps real Graphify `graph.json` → import; server route + CLI `workcell code-graph from-repo`. Verified against real `graphifyy` v0.8.28. **Remaining = deployment choice to install Python Graphify (dormant→active).** WC-121/122. | [New, optional sidecar] |

## 9. Cost / Finance / Budgets

| Feature | Description | Tag |
|---|---|---|
| Cost events / mapping | `cost_events`, billed-cost normalization (shared extraction from heartbeat). | [Paperclip] (extraction [New]) |
| Finance events | `finance_events`. | [Paperclip] |
| Budgets / budget policies | Generic-scope policies (company/agent/project); heartbeat blocks invocations via `getInvocationBlock`. Per-agent + per-company caps. | [Paperclip] |
| Usage Center / provider quota | `ProviderQuotaCard`, `BillerSpendCard`, budget bars; subscription quota sync (Anthropic OAuth/Claude CLI, codex). | [Paperclip] |
| Confidence chips (Exact/Synced/Estimated) | `quotaConfidence(source)` badge with tooltip. PLAN §9 #8 ✅. WC-20. | [New] |
| Billing-preserving deletes | Agent/issue/project/goal deletes detach billing (FK SET NULL) instead of purging → company spend totals stay accurate; "Deleted agent" label for orphaned costs. WC-137/139/141. | [New] |

## 10. Plugins & MCP

| Feature | Description | Tag |
|---|---|---|
| Out-of-process plugin host | Loader, lifecycle, worker manager, sandbox runtime, job scheduler, event bus, tool registry, managed agents/routines/skills, secrets handler (~60 `plugin-*` services). | [Paperclip] |
| Plugin SDK + scaffold | `packages/plugins/sdk`, `create-workcell-plugin`, example plugins. | [Paperclip] (renamed `@workcell/*`) |
| Plugin UI slots | `page`, `detailTab`, `dashboardWidget`, `commentAnnotation`; iframe isolation. | [Paperclip] |
| Inbound MCP server | `packages/mcp-server` exposes Workcell tools (incl. KG tools) to external MCP clients. | [Paperclip] (KG tools [New]) |
| **Outbound MCP bridge** | `packages/mcp-bridge` — **the single net-new infrastructure package.** `McpClient` (SDK stdio transport): connect/listTools/callTool, bounded timeouts, sanitized errors, reconnect-safe. WC-60/68. | [New] |
| Outbound MCP client registry | Resolves `sourceKind='mcp'` capabilities → per-(company,key) client; **re-gates on every call** (revocation effective immediately); telemetry. WC-61. | [New] |
| MCP server capability bootstrap | Seeds graph-enrichment / open-design / code-graph as `mcp` capabilities (env-driven command). WC-64/108. | [New] |
| Plugin `ctx.mcpClients` host RPC ⚑ | Worker→host MCP proxy; **companyId from trusted invocation scope (never plugin params)** → cross-tenant blocked. WC-65. | [New] |
| Adapter MCP injection ⚑ | claude-local `.mcp.json` / codex-local `config.toml`, only when `WORKCELL_ADAPTER_MCP_INJECTION` flag ON. **Default OFF = byte-for-byte unchanged invocation.** WC-67/69. | [New, flag-gated] |

## 11. Workspaces (project / execution, git worktrees)

| Feature | Description | Tag |
|---|---|---|
| Project workspaces | `project_workspaces` (primary repo, cwd, ref). | [Paperclip] |
| Execution workspaces + git worktrees | `execution_workspaces` realized via `git worktree add` (+reuse); per-run env/lease/JWT in heartbeat. | [Paperclip] |
| Environments + leases | Config, probe, run-orchestrator, runtime read-model, command authz. | [Paperclip] |
| Pair worktree primitive | `realizePairWorktree` / `ensurePairWorkspace` reuse the decoupled realize primitive without lease/JWT. WC-130/131. | [New] |
| Workspace diff plugin | `plugin-workspace-diff`. | [Paperclip] |

## 12. Approvals / Governance / Decisions

| Feature | Description | Tag |
|---|---|---|
| Approvals subsystem | `approvals` + Approvals/ApprovalDetail; reused for install/release/plan-conflict. | [Paperclip] |
| Governance reframe | Governance = focus human time on key decisions (release, blocked-issue, skill/plugin/MCP install, plan-conflict) — **not human-removal.** | [Changed — philosophy] |
| Delegated / standing approval | Manual (board) vs delegated (top Planner auto-approves within scope; high-risk excluded; audited "by delegation"; revocable). D18. | [New — design] |
| Decisions log (D1–D21) | `DECISIONS.md` governance lineage. | [New] |

## 13. Multi-tenant / RBAC / Access

| Feature | Description | Tag |
|---|---|---|
| Multi-company isolation | Company-scoped data; tenant scoping hardened (KG WC-54, issue ancestors WC-112, MCP host scope WC-65, issue write-guards WC-138/140). | [Paperclip] (hardening [New]) |
| RBAC permission keys | 8 keys (agents:create, environments:manage, users:invite, …). Advanced RBAC = roadmap. | [Paperclip] |
| Invites / join requests / memberships | Company invites, join-request queue, memberships, board-claim, CLI auth. | [Paperclip] |
| Company import/export (portability) | `company-portability` workcell/v1 YAML round-trip (incl. plan-report language). | [Paperclip] (Workcell fields [New]) |
| Secrets store | Company-scoped secrets, bindings, access events; never in manifests. | [Paperclip] |
| Activity log (append-only enforced) | Immutable via BEFORE UPDATE/DELETE trigger (migration 0096); narrow GUC-gated purge for entity deletion (0101). PLAN §9 #10 ✅. WC-29/116. | [Changed] (immutability [New]) |
| Delete-cascade hardening | Full FK audit so company/agent/issue/project/goal hard-deletes don't 500 on no-onDelete children (content pre-delete; billing detach). WC-116/117/118/124/134/135/141/142. | [New] |

## 14. i18n

| Feature | Description | Tag |
|---|---|---|
| Locale switch mechanism | storage > browser > en; `LanguageSelect` in account menu; RTL for ar/fa/he/ur; partial-locale tolerance (English fallback). WC-82. | [New] |
| App-wide string wiring | ~46 pages + ~32 components + all chrome via `t()` with English `defaultValue` (English byte-unchanged); ~3400+ keys. WC-83–106. | [New] |
| Korean translation (verified) | `ko.json` fully populated; 38 other locales partial → English fallback (no unverified machine translation). | [New] |
| i18next infrastructure | 40 locale files, react-i18next, key-parity/injection validation. | [Paperclip] (was 0% wired) |

## 15. Onboarding

| Feature | Description | Tag |
|---|---|---|
| Onboarding wizard | 4 steps (Company / Agent / Task / Launch) → company + founding agent + first issue. | [Paperclip] |
| Reframed first-plan copy | "CEO…hire a founding engineer" → Orchestrator identity (board owns direction; proof discipline). WC-71. | [Changed] |
| Workcell principles surfaced | `WorkcellPrinciples` on onboarding + Dashboard empty state + /design-guide. WC-80. | [New] |
| Bootstrap from spec / repo | Ingest route (WC-41) + CLI `workcell bootstrap from-repo` (README/package.json parsing, TODO extraction). PLAN §9 #1 ✅. WC-48. | [New] |
| Instance/admin bootstrap | CLI `bootstrap-admin` (DB value `bootstrap_ceo` + `pcp_bootstrap_` token prefix preserved as contracts). WC-75. | [Changed] (re-labeled) |

## 16. Branding / Identity

| Feature | Description | Tag |
|---|---|---|
| Full Paperclip→Workcell rebrand | Identifiers, `@workcell/*`, `WORKCELL_*` env, `~/.workcell`, CLI banner, hooks. | [Changed] |
| Orchestration brand identity | Indigo-blue accent, `WorkcellMark` orchestration-hub glyph, favicon set, dark-default charcoal theme. WC-70/71/75. | [New] |
| Tagline reframe | "zero-human companies" → "Human-directed orchestration for AI agent teams". | [Changed] |
| Preserved fork lineage | `LICENSE` (MIT) + `NOTICE` retain Paperclip attribution. | [Paperclip] |

## 17. Open Design Dashboard (D13)

| Feature | Description | Tag |
|---|---|---|
| Open Design plugin (capability pack) | `plugin-open-design-dashboard` — page slot, artifact listing, version diff + sandboxed iframe preview. PLAN §9 #4 ✅. WC-31/40/47/49. | [New] |
| Open Design MCP consumption ⚑ | Consumes the open-design MCP via `ctx.mcpClients` (graceful fallback). **Real daemon not wired** (dormant). WC-66. | [New, capability-gated] |

## 18. Routines, Goals, Dashboard, Instance

| Feature | Description | Tag |
|---|---|---|
| Routines (cron) | Scheduled agent routines + managed-routines via plugins. | [Paperclip] |
| Goals | Goal tracking + goal-fallback for issues. | [Paperclip] |
| Dashboard / live | Metrics, charts, recent activity, live events. | [Paperclip] |
| Cloud upstreams | Cloud relay/upstream config + migration wizard. | [Paperclip] |
| Instance settings / backups | General/experimental settings, DB backups, instance access. | [Paperclip] |
| App-level error boundary | Route + root boundaries so a page crash degrades in-pane, not white-screen. WC-106. | [New] |

---

## Workcell vs Paperclip — Directional Delta

1. **Metaphor: CEO-runs-a-company → board-owns-direction.** Paperclip's "zero-human company / CEO" framing is replaced by a human-as-board model: people own direction and approvals; agents execute. The `ceo` enum survives only as an internal auth-root primitive (re-labeled "Orchestrator"); the user-visible identity is fully reframed (WC-70–75).
2. **Agents as functional roles, not job titles.** C-suite (ceo/cto/cmo/cfo) → flow-oriented taxonomy (orchestrator, lead, pm, engineer, designer, researcher, writer, qa, security, devops, general), broadening scope beyond software.
3. **Proof-gated discipline is the spine.** Net-new: no Done without a proof bundle, agent proof-of-work directives, auto-injected QA signoff, and a Compound learning cycle (auto-checklist → LLM auto-fill → follow-up issues) — none in stock Paperclip. The most load-bearing behavioral change.
4. **issueflow execution philosophy.** Goal-experience → issue → evidence; vertical slices; local proof-first; GitHub optional (audit layer, not required).
5. **Net-new subsystems on the Paperclip control plane.** The single net-new *infrastructure* package is `packages/mcp-bridge` (outbound MCP). On top: Knowledge Graph (D12), Code Graph / Graphify (D20), Capability Registry with trust tiers, 2-model Pair collaboration. Paperclip's control plane (heartbeat, budgets, org chart, approvals, plugins, workspaces, multi-tenant) is inherited largely as-is.
6. **Pair work as a bounded, commercial-grade loop.** WorkOwner=single|pair, max-10-round loops with explicit stop policies, cost ceilings, convergence detection, concurrency guards, and (flag-gated) real-LLM + isolated git-worktree file editing (D21). Issue assignee stays single; only the *owner* can be a pair.
7. **Outbound capability extension via MCP + sidecars.** Rather than forking external engines, Workcell injects capabilities through outbound MCP clients (capability-gated, tenant-scoped, re-gated per call) and plugin capability packs — Open Design (D13) and Graphify (D20) as dormant→active sidecars, not core forks.
8. **Multi-tenant & integrity hardening.** Adversarial audits drove fixes that per-slice tests missed: cross-tenant leaks (KG, issue ancestors, MCP host scope), append-only audit log (DB trigger), capability self-grant/peer-revoke prevention, and a full delete-cascade FK audit across every entity (incl. WC-141/142 agent/company delete 500s).
9. **Internationalization.** Paperclip shipped i18next 0% wired; Workcell wired the entire app (~46 pages, ~32 components, ~3400 keys) with English defaults + verified Korean, partial-locale tolerance, RTL support, plan-report language preference.
10. **Honest scope & flag discipline.** Several headline capabilities are deliberately flag-gated and OFF by default (`WORKCELL_PAIR_LIVE_LLM`, `WORKCELL_PAIR_LIVE_WORKSPACE`, `WORKCELL_ADAPTER_MCP_INJECTION`). The 10-state Kanban model and 4-plane context model remain spec-only. Graphify / Open Design need a deployment choice to install the external engine. PLAN §9's 11 MVP criteria are all ✅, with explicitly disclosed out-of-MVP remainders.
