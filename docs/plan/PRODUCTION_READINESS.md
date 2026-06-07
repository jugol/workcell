# Workcell — Production-Readiness Roadmap

> Commercial-service-grade hardening program. Sourced from a 4-dimension audit
> (security · reliability · data/perf · UX-a11y), 2026-06-06. Each finding:
> `Pn · area · file:line · issue · fix`. Execute P0 → P1 → P2 as proof-gated
> slices (branch issue/WC-xxx, --no-ff merge). Status: 🔲 todo · 🚧 wip · ✅ done.

---

## A. Data integrity & performance  (audit `data-perf`, done)

### P0
- 🔲 **heartbeat `tickTimers` full-agents scan + N+1** — `server/src/services/heartbeat.ts:9898` `db.select().from(agents)` scans ALL agents across ALL companies every 30s, then per-agent `enqueueWakeup`. O(total agents)/tick. Fix: SQL pre-filter (status/enabled predicate) + index `(status)`; batch-enqueue.
- 🔲 **recovery sweeps seq-scan `heartbeat_runs`** — `heartbeat.ts:6584,6709` + `recovery/service.ts:1523` (`reapOrphanedRuns`/`resumeQueuedRuns`/`scanSilentActiveRuns`) filter bare `status='running'/'queued'` (no companyId); every index leads with `(companyId,status,…)` → seq-scan unbounded append-only runs table every 30s. Fix: partial index `ON heartbeat_runs (status) WHERE status IN ('running','queued')`.
- 🔲 **migration `cp -r` nesting** — `packages/db/package.json:39` `cp -r src/migrations dist/migrations`; on incremental rebuild nests → `dist/migrations/migrations/` (already broken in tree); `client.ts:9,11` then can't find `dist/migrations/meta/_journal.json` → broken migration discovery in Docker/packaged builds. Fix: `rm -rf dist/migrations && cp -r …` (clear target first). **One-liner; highest ROI.**

### P1
- 🔲 **agent hard-delete FK fragility** — 22 FKs → `agents.id` with no onDelete; teardown hand-maintained across 25 statements (`services/agents.ts:512`); executor writes into runtime_state/task_sessions/wakeup_requests between purge & delete → FK-violation rollback (WC-171 race still open). Fix: `onDelete:"cascade"` on executor-owned ephemeral tables, `"set null"` on audit pointers.
- 🔲 **issue hard-delete FK** — `issue_read_states.issueId` + `feedback_votes.issueId` are `.notNull()` FK to issues.id, no onDelete → SET-NULL detach impossible → issue delete FK-violates; `finance_events.issueId` (nullable, no onDelete) RESTRICTs. Fix: `onDelete:"cascade"` on read_states/feedback_votes; purge/SET NULL finance_events.
- 🔲 **missing `(companyId, createdAt)` index on heartbeat_runs** — dashboard 14-day activity + `scanSilentActiveRuns ORDER BY createdAt` can't use status-leading indexes. Fix: add it (also serves run-history list).
- 🔲 **`reconcileStrandedAssignedIssues` unbounded + N+1** — `recovery/service.ts:2342` every 30s `SELECT *` issues (no LIMIT) + per-issue getAgent/hasActiveExecutionPath. Fix: bounded claim-batch (like `tickDueIssueMonitors` @50) + project + batch lookups.
- 🔲 **`svc.list` no internal cap** — `services/issues.ts:3699` no LIMIT when filters.limit absent (route clamps, internal callers don't). Fix: hard cap inside svc.list.

### P2
- 🔲 index migrations non-CONCURRENT (70 CREATE INDEX, 0 CONCURRENTLY) → write-lock on populated tables; use CONCURRENTLY for future hot-table indexes.
- 🔲 large jsonb/text on runs row materialized in scan/list loops → project columns on scan paths.
- 🔲 no retention/partitioning on append-only cost_events/activity_log/heartbeat_run_events.
- 🔲 companies.issueCounter/spentMonthlyCents app-side increment can race → ensure atomic `SET x=x+n` SQL + CHECK ≥0.

**Top-3 must-fix:** (1) partial status index on heartbeat_runs, (2) tickTimers SQL filter, (3) migration cp -r clear-first.
**Good (don't over-correct):** issues.list HTTP path well-engineered (bounded, projected, chunked IN); dashboard pure indexed aggregates; tickDueIssueMonitors correct bounded-claim.

---

## B. Security & multi-tenancy  (audit `security`, done)

> Headline: authz/tenant isolation **notably mature** — resolve-row-by-id → `assertCompanyAccess(row.companyId)` (correct IDOR pattern) applied consistently; in-app FK re-validation (WC-138/140/112). Real gaps = **abuse/rate-limiting + secret-in-logs**, NOT broken access control.

### P1
- 🔲 **secrets written to server.log on failed requests** — `middleware/logger.ts:32,66-94` logs full req.body/query/params on every 4xx/5xx; pino `redact` only covers `authorization` header → a failed POST /secrets, /secrets/:id/rotate, agent-key create, webhook create, or `{type:"plain"}` env binding persists the **plaintext secret to disk**. `redaction.ts` sanitizer NOT wired into this path. Fix: pipe reqBody/Query/Params through `sanitizeRecord()`/`redactEventPayload()` + add pino redact paths. **(highest severity, low effort)**
- 🔲 **no rate-limiting / per-tenant quotas** — only limiter is company-search. LLM-spend ops (/deliberate, /heartbeat/invoke, /wakeup, draft-from-prompt, draft-grill, pair turns, routine runs) have NO pre-spend throttle; budgets are reactive + opt-in. Cost/DoS + noisy-neighbor. Fix: per-tenant+per-actor token-bucket on LLM/dispatch routes (reuse `plugin-secrets-handler.ts createRateLimiter`) + default company spend ceiling.
- 🔲 **bootstrap/ingest unbounded bulk** — `routes/bootstrap.ts:33,47` gated by assertCompanyAccess only (no assertBoard), loops req.body.issues with NO length cap → any member/agent creates unbounded projects+issues (each can trigger wakeups). Fix: cap issues[] + board/permission gate.

### P2
- 🔲 instructions root path unconstrained — `routes/agents.ts:1022` board mgr can set adapterConfig.instructionsRootPath to ANY absolute host path then write to it (relative traversal IS contained). Fix: allowlist roots / require instance-admin for absolute.
- 🔲 webhook `signingMode:"none"` fires routine runs (LLM spend) for anyone with the URL (publicId 96-bit). Fix: rate-limit public fires + warn.
- 🔲 prompt-injection residual (user text → LLM context) — bounded (run executes as company-scoped agent, caller has company access); keep tool/permission gating as the boundary.
- 🔲 CSRF allow-set trusts X-Forwarded-Host (`board-mutation-guard.ts:19`) — only server-side-reachable; prefer fixed configured origin.
- 🔲 agent JWT iss/aud validated only-when-present (`agent-auth-jwt.ts:125`) — assert unconditionally.
- 🔲 no per-company agent count cap (creation is permission+board gated, but unbounded).

**Top-3:** (1) secrets-in-logs (silent customer-secret exfil to disk, redaction infra already exists), (2) rate-limiting/quotas on LLM-spend+creation, (3) bootstrap/ingest cap+gate.
**Strong (replicate, don't re-audit):** local_trusted loopback-bound+private-enforced at startup; agent JWT HS256 hardcoded-alg+constant-time; secrets plaintext only in provider-encrypted material (never in route responses); webhook HMAC correct; resolve-by-id→assertCompanyAccess discipline consistent.

## C. Reliability & lifecycle  (audit `reliability`, done)

### P0
- ✅ **[DONE · Wave 1 · WC-212]** ~~no process-level error handlers~~ — `registerProcessSafetyNetHandlers` in `index.ts` (log+keep-serving on rejection, guarded exit on uncaught).
- 🔲 **shutdown doesn't drain or kill children** — `index.ts:937-966` + `app.ts:557-567` `shutdown()` exits immediately; never drains `activeRunExecutions`, never SIGTERM/SIGKILLs spawned claude/codex children → every deploy orphans live CLIs + leaves 'running' rows. Fix: async drain (stop intake → await/cancel runs → terminate `runningProcesses` SIGTERM→KILL) on a bounded deadline.
- 🔲 **startup can't reclaim its own orphaned embedded-PG (companion to shutdown-drain; found live 2026-06-06)** — when the server process dies without draining, its embedded-Postgres cluster is orphaned and keeps holding the data dir's shared-memory block. The next boot on the same `WORKCELL_HOME` then dies with `FATAL: pre-existing shared memory block is still in use`, and a **normal-privilege restart cannot kill the orphan** (`Stop-Process`/`taskkill /F /T` → Access denied; it sits in the prior process's security context). So a single hard crash can wedge the instance until a machine reboot. Fix options: (a) on the clean-exit path (Wave 2b), `pg_ctl stop -m fast` the embedded cluster before process exit so no orphan survives; (b) on boot, detect the stale `postmaster.pid`/shm-in-use condition and attempt a scoped `pg_ctl stop`/recovery on our own data dir before failing; (c) at minimum, replace the raw PG error with an actionable message naming the data dir + the orphaned PID to kill. Mitigation today: boot on a fresh `WORKCELL_HOME`.
- ✅ **[DONE · Wave 2 · WC-213]** ~~plugin-job orphan-run, no reaper~~ — `reapStalePluginJobRuns` boot reconciler (mirrors `reapStaleDeliberationRuns`) fails orphaned 'running' plugin-job runs.

### P1
- 🔲 **main run path unbounded** — `adapter-utils/server-utils.ts:2015` + claude/codex execute: `config.timeoutSec` defaults 0 → NO kill timer → wedged CLI runs forever; the silent-run watchdog blocks the issue but does NOT cancel the process. (WC-211 fixed deliberation only.) Fix: default max wall-clock timeoutSec for ALL heartbeat runs + watchdog hard-kill.
- 🔲 **heartbeat tick no re-entrancy guard** — `index.ts:783-849` 30s setInterval runs 7 reconcilers sequentially; under load they overlap → concurrent recovery passes; read-then-insert dedup (createOrUpdateStaleRunEvaluation) double-creates escalation issues. Fix: "already running" skip guard + unique constraints on dedup keys.
- 🔲 **DB client no timeouts/pool tuning** — `client.ts:48` `postgres(url)` no options: pool max 10, no connect_timeout/statement_timeout/idle_in_transaction_session_timeout → a hung query pins connections. Fix: set explicit timeouts + size max + surface pool exhaustion in health.
- 🔲 **agent-start-lock in-process only** — `agent-start-lock.ts` Map-based; multi-process (embedded-PG reuse / double-launch) has no cross-process dispatch coord beyond per-run CAS (plugin-jobs/reconcilers NOT CAS). Fix: DB advisory lock / instance lease so a 2nd process refuses schedulers.
- 🔲 **pair_groups 'active' no reaper** — abandoned active pair holds worktree+branch forever. Fix: stale-active-pair reaper (idle threshold) → abort+reap.
- 🔲 **process/HTTP adapters default timeout 0** — `adapters/process/execute.ts:34` + `http/execute.ts:10` unbounded. Fix: sane non-zero default; treat 0 as "use default" not "infinite".

### P2
- 🔲 git_worktree leak on crash — no periodic `git worktree prune`/orphan-dir sweep (execution-workspaces.ts:679).
- 🔲 `waitForExternalAdapters()` unbounded before listen() (index.ts:870) → bound + proceed degraded.
- 🔲 embedded-PG "reuse/stale-pid" can race two instances onto one cluster (index.ts:390) → instance lock before reuse.

**Top-3:** (1) unhandledRejection/uncaughtException handlers, (2) shutdown drain+kill children, (3) bound+reap every long-running unit (plugin-job boot reaper + hard-kill hung runs + tick re-entrancy guard).
**Solid (don't over-correct):** run-dispatch CAS (`claimQueuedRun`) solid; Express 5 auto-catches async route rejections → clean 500; runtime-services reconciled on boot; deliberation already hardened (WC-211).

## D. UX polish & accessibility  (audit `ux-a11y`, done)

> Headline: UI better than typical pre-1.0 — ErrorBoundary (route+top-level, localized, raw error behind `<details>`), PageSkeleton, EmptyState, `isError` inline mutation feedback are the house patterns. Real gaps = keyboard-reachability of 2 core composites + a few silent mutations that slipped WC-200.

### P1
- 🔲 **EntityRow keyboard** — `components/EntityRow.tsx:72` onClick-mode renders bare `<div onClick>` (no role/tabIndex/keydown) → the app's standard list row is keyboard-unreachable. Fix: role="button" tabIndex=0 onKeyDown(Enter/Space) when onClick && !to. **(highest blast radius — backs most clickable rows)**
- 🔲 **MetricCard keyboard** — `components/MetricCard.tsx:46` same bare-div issue → Dashboard metric drill-downs not keyboard-reachable. Same fix.
- 🔲 **GoalDetail silent mutations** — `pages/GoalDetail.tsx:88,103` + GoalProperties updateGoal/uploadImage have no onError/isError → goal edits revert silently (WC-200 class). Fix: isError inline.
- 🔲 **Companies rename/delete silent** — `pages/Companies.tsx:55,64` editMutation/deleteMutation only onSuccess → destructive company delete fails silently. Fix: onError/isError surface.
- 🔲 **NewAgent i18n** — `pages/NewAgent.tsx:127,192,203,332` real route ships hardcoded English ("Failed to create agent", "Agent name", "Creating…") in a ko-wired app. Fix: t()+defaultValue.
- 🔲 **icon-only buttons missing aria-label** — `AgentDetail.tsx:2433,2444,2562` + `PluginSettings.tsx:161` (new-file/close/back). Fix: aria-label.

### P2
- 🔲 global `prefers-reduced-motion` reset — index.css:320-385 only guards 3 keyframes; 85 `animate-spin`+23 `animate-pulse` unguarded. Fix: `@media(prefers-reduced-motion){*{animation-duration:.01ms!important}}` or motion-safe:.
- 🔲 Inbox toolbar icon buttons title-only (no aria-label) — Inbox.tsx:2035-2132.
- 🔲 CompanySwitcher color-only status dot (no text/aria) — CompanySwitcher.tsx:52-89.
- 🔲 interactive `<div onClick>` lacking keyboard — GoalTree.tsx:68, Costs.tsx:769, IssueDetail.tsx:3967 (good examples exist at AgentDetail:3055/Companies:122 — just inconsistent).
- 🔲 AdapterManager.tsx:393 bare "Loading…" text + no isError branch. Fix: PageSkeleton + error surface.
- 🔲 EmptyState.tsx:15 icon chip no rounding vs design-guide. Fix: rounded-lg/full.

**Top-3:** (1) EntityRow+MetricCard keyboard (~10 lines, whole-app blast radius), (2) close silent mutations (GoalDetail, Companies rename/delete), (3) NewAgent i18n + global reduced-motion reset.
**Solid (don't over-correct):** ErrorBoundary commercial-grade; detail-page state coverage; i18n ~fully wired (only DesignGuide/UxLab dev pages raw); responsive ok; Button focus-visible ring; StatusBadge color+text+shape.

---

## Execution order (synthesized, all 4 audits)

> Overall verdict: Workcell is **further along than a typical pre-1.0** — authz/tenant isolation mature, error-boundary/state coverage solid, deliberation hardened. Commercial-grade gaps cluster in **operational resilience (process/shutdown/reapers), abuse/rate-limiting, secret-in-logs, and a few hot-path scans + a11y/silent-mutation polish.** None are "rewrite" — all are bounded slices.

**Wave 1 — P0 quick high-ROI (do first; small, high blast radius):**
1. 🔲 **SEC: secrets-in-logs** — wire `redaction.ts` into the HTTP req-body logger (logger.ts) + pino redact paths. *(silent customer-secret exfil; infra exists)*
2. 🔲 **DATA: migration `cp -r` clear-first** — 1-line build fix (already broken: `dist/migrations/migrations/` in tree). *(breaks Docker deploy)*
3. 🔲 **REL: process error handlers** — top-level unhandledRejection/uncaughtException (log+keep-serving / guarded exit).
4. 🔲 **SEC: bootstrap/ingest cap+gate** — cap issues[] length + board gate.
5. 🔲 **DATA: heartbeat_runs partial status index** — `(status) WHERE status IN ('running','queued')`. *(stops the 30s seq-scan melt)*

**Wave 2 — P0/P1 operational resilience (bigger):**
6. 🔲 **REL: shutdown drain + kill children** — stop intake → await/cancel runs → SIGTERM/KILL tracked CLIs (deadline) → **`pg_ctl stop` the embedded PG so no orphaned cluster survives to wedge the next restart** (see C/P0 startup-recovery finding).
7. 🔲 **REL: plugin-job boot reaper** + lease (mirror reapStaleDeliberationRuns).
8. 🔲 **REL: main-run-path timeout** (extend WC-211 to all heartbeat runs) + watchdog hard-kill.
9. 🔲 **REL: heartbeat tick re-entrancy guard** (+ unique constraints on escalation dedup keys).
10. 🔲 **DATA: tickTimers SQL filter** (due-agents predicate, not full scan) + **REL: DB client timeouts/pool**.

**Wave 3 — P1 abuse + UX polish + data integrity:**
11. 🔲 **SEC: rate-limiting/quotas** on LLM-spend + creation routes + default spend ceiling.
12. 🔲 **UX: EntityRow + MetricCard keyboard** (role/tabIndex/keydown) — whole-app a11y.
13. 🔲 **UX: silent mutations** (GoalDetail edits, Companies rename/delete) + NewAgent i18n + global reduced-motion reset.
14. 🔲 **DATA: FK cascades** (agent-teardown ephemeral tables, issue_read_states/feedback_votes) + `(companyId,createdAt)` index + svc.list internal cap.
15. 🔲 **REL: pair-group stale-active reaper** + adapter default timeouts.

**Wave 4 — P2 hardening:** index CONCURRENTLY, retention/partitioning, worktree prune, instructions-root allowlist, JWT iss/aud unconditional, remaining a11y aria-labels, agent count cap, etc. (see per-section P2 lists).

---
## Progress
- ✅ **Wave 1 done** — WC-212 (`6ada0e3`): secrets-in-logs redaction · migration cp-r clear-first · process unhandled/uncaught handlers · bootstrap board-gate+200-cap · heartbeat_runs partial status index (0113). 26 tests green.
- ✅ **Wave 2 done** — WC-213 (`568e19f`): plugin-job boot reaper · main-run timeout (default 1800s, explicit preserved) · tick single-flight guard · tickTimers SQL status-filter · DB client timeouts/pool. 15 tests green. **(Shutdown-drain → Wave 2b, deferred — touches process exit, needs careful attention.)**
- ✅ **Wave 3 UX done** — WC-214 (`484a8bc`): EntityRow/MetricCard keyboard-reachable · GoalDetail/Companies silent-mutation error surfaces · NewAgent i18n · global reduced-motion reset · icon-only aria-labels. UI tc 0; 50 tests green.
- ✅ **Wave 3 SEC done** — WC-215 (`986ac81`): per-tenant LLM-route rate limiting — generic sliding-window core (extracted from company-search, zero behavior change) + per-`company:actor` limiter (60s/12, env-overridable, shared process-wide so the cap holds across all expensive routes per tenant) guarding 6 model-backed routes (deliberation start · pair run-round · checklist auto-fill · context compaction · draft-from-prompt · parallel-dispatch wake). 429+Retry-After+X-RateLimit-*. 12 new tests; bootstrap-ingest correctly excluded (persists a client-built spec, not an LLM call).
- ✅ **Wave 2b done** — WC-216 (`54dd320`): graceful shutdown run-drain — on SIGTERM/SIGINT, `shutdown()` drains in-flight heartbeat runs + SIGTERM→SIGKILLs their claude/codex CLI children on a bounded deadline (`WORKCELL_SHUTDOWN_DRAIN_DEADLINE_MS`, 10s) before stopping PG/exit; reuses `runningProcesses` + `terminateLocalService`. Pure DI `drainActiveWork()`, 5 unit tests. **(Clean-exit `embeddedPostgres.stop()` already existed — index.ts:1072; the orphan-startup clearer-error → Wave 4. Deadline layering intentional: signals=full drain, crash=fast-bounded by the 3s backstop.)**
- ✅ **Wave 3 DATA done** — WC-217 (`9454795`): FK cascade migration 0114 (`issue_read_states` + `feedback_votes` → CASCADE, defense-in-depth alongside the WC-118 manual purge) · `heartbeatService.list` cap (1000, was unbounded on the hot runs endpoint) · pair-group reaper correctly **SKIPPED** (lifecycle: `'active'` is durable, rounds run synchronously in-request, no crash-orphan). agent-teardown FKs investigated → no gap (already purged/cascade). 7 + 25 + 12 tests green.
- ✅ **Wave 4 SEC done** — WC-218 (`3caf54e`): agent JWT iss/aud asserted UNCONDITIONALLY (`agent-auth-jwt.ts` — was check-only-when-present; the minter always sets them + config always defaults them, so no legit-token breakage) · instructions-root allowlist (`agent-instructions.ts` updateBundle — an absolute external root must be under the instance dir or `WORKCELL_INSTRUCTIONS_ROOT_ALLOWLIST`, else 422; managed/default flow unchanged) · per-company agent count cap (`agents.ts` create — `WORKCELL_MAX_AGENTS_PER_COMPANY` default 500, 0=unlimited, counts non-terminated, off the existing dedup query). 26 + adjacent tests; tc 0.
- ✅ **Wave 4 cleanup done** — WC-219 (`8f9f1c6`): periodic git-worktree prune + orphan sweep (`execution-workspaces.ts` — safe-by-default: `git worktree prune` always runs, orphan-dir delete is aged-AND-opt-in `WORKCELL_WORKTREE_SWEEP_DELETE`; pure-DI `planWorktreeSweep`, 10 tests; wired into the WC-216 shutdown drain; resolves the abandoned-pair worktree leak) · actionable embedded-PG orphan startup error (names data dir + postmaster PID + remediation) · Inbox icon-button aria-labels (i18n en+ko) + verified WC-214's AgentDetail/PluginSettings coverage. Plus a stale-services-mock greening (`216ca06`) + an Inbox async-render de-flake (`99a97d1`) for a green suite.
- 🟢 **Production-readiness program COMPLETE for all bounded findings** — Waves 1 · 2 · 2b · 3-UX · 3-SEC · 3-DATA · 4-SEC · 4-cleanup all merged + independently re-verified; full 0000→0114 migration chain boots clean. **Intentionally deferred (NOT bounded code-sweeps — each needs a product/ops decision, not a unilateral change):** retention/partitioning policy on append-only `cost_events`/`activity_log`/`heartbeat_run_events` · the CONCURRENTLY-index *guideline* for future hot-table migrations (no specific index pending). **Open as measure-first future work:** heartbeat_runs `(company_id, created_at)` index only if profiling proves the activity-feed sort is a real bottleneck (existing `(company_id,…)` indexes already prevent seq-scans).
- 📋 **Next-pass investigation notes (2026-06-06 — gathered before any blind execution; the remaining Wave 3 data items need *judgment*, not rote):**
  - **heartbeat_runs `(company_id, created_at)` index → DROPPED from the list (measure-first).** The activity feed query `activity.ts:414/428` is `WHERE company_id=? ORDER BY created_at DESC`, but the table ALREADY has several `(company_id, …)`-leading indexes (`company_agent_started`, `company_status_last_output`, `company_status_process_started`, `company_liveness`), so company-filtered reads do NOT seq-scan — a dedicated index would only remove a *sort* step for that one feed query. heartbeat_runs is INSERT-heavy (every 30s × every agent), so each extra index taxes every insert; the added write-cost likely exceeds the read savings. Add ONLY if profiling proves the feed sort is a real hot-path bottleneck.
  - **pair-group stale-active reaper → confirm the lifecycle FIRST.** `pair_groups.status` defaults to `'active'`, which may be a DURABLE open-collaboration state, not a transient orphan-prone `'running'` like `deliberation_runs`. The transient work lives in `pair_turns`/rounds. Before mirroring `reapStaleDeliberationRuns`, verify a crashed in-flight round actually wedges a group in a recoverable-but-stuck status — the reaper may be unnecessary, or belong on a round/turn status rather than the group.
  - **`svc.list` internal cap** — needs discovery: grep service `.list()` methods doing `db.select()…` without `.limit()` in a hot path; add a defensive cap only where a query can return unbounded per-tenant rows.
  - **FK cascades** — needs per-FK judgment (cascade vs set-null vs restrict); do NOT bulk-add `onDelete:'cascade'`. Scope to the specific findings only (agent-teardown children, `issue_read_states`, `feedback_votes`).
