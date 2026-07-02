# BACKLOG_BOARD — Workcell

> 로컬 우선 칸반 보드 (GitHub 채택 시 동일 구조를 이슈로 매핑). 운영 상태는 위, 기록 상태는 아래로 분리.
> **현 시점 모든 이슈는 `Draft`이며 dispatch/실행되지 않았다.** 첫 dispatch는 사용자 확인(특히 DECISIONS D1) 이후.

## 상태 모델
운영: `Draft` → `Ready` → `In Progress` → `In Review` → `In QA` → `Done`
별도 레일: `Blocked by User`(집중 노출), `Blocked by System`
기록(숨김 가능): `Done` / `Cancelled` / `Archived`

분류 태그: `core`(사용자 가시 핵심) · `support`(코어를 가능케 함) · `internal`(내부/도구) · `deviation`(계획 이탈)

---

## Wave 1 (Phase 1 — 실행 코어 / single-owner) — 전부 Draft

> 목표 vertical slice: **"보드에 자연어 입력 → Planner가 이슈 draft 생성 → single Developer 실행 → proof와 함께 Done."**
> WC-2~WC-6은 WC-1(스택 확정)에 blocked.

### WC-1 · Workcell 포크 + 베이스 셋업 (build green) ✅ baseline
- 분류: `internal` · owner: Developer Agent
- 상태: `In Review` (브랜치 `issue/wc-1-fork-workcell-strip`) — strip은 WC-1b/c로 분리
- 완료: 포크 import(`merge b1c59a3a`, 2,532파일, `upstream` 원격 유지) · pnpm 9.15.4 · `.gitignore` 통합 · **`pnpm build` green(26/27)** · `scripts/check.ps1`→`pnpm typecheck` 연결.
- Proof: `pnpm build` exit 0 + `scripts/check.ps1`.
- Plan link: PLAN §6, DECISIONS D1/D10.

### WC-1b · 벤더 어댑터 strip (claude/codex/process/http만 유지) — ✅ Done
- 상태: `Done` (2026-05-25, typecheck green; build 검증). **잔재 정리 후속(`chore/acpx-strip-cleanup`):** 패키지/UI 제거는 됐으나 코드/테스트/스크립트/Dockerfile/vitest.config에 acpx_local·grok_local 참조 잔존이 발견됨 → 일괄 정리(8개 stripped adapter의 config 잔재 + acpx/grok 코드 참조).
- 분류: `internal` · owner: Developer Agent · 의존: WC-1
- Acceptance(초안): `acpx, cursor, cursor_cloud, gemini, grok, openclaw_gateway, opencode, pi, hermes` 어댑터 제거 — `packages/adapters/*` 삭제 + `server/src/adapters/registry.ts`·`builtin-adapter-types.ts` 정리 + UI `ui/src/adapters/*`·선택지 정리 + 관련 테스트/스크립트(`smoke:openclaw-*`, `evals`) 제거. `pnpm build`/`typecheck` green 유지.
- Proof: 빌드/타입체크 green + 어댑터 목록에 claude/codex/process/http만.
- Plan link: `docs/plan/STRIP_PLAN.md` §MEDIUM. (~60파일 영향 — 단독 이슈)

### WC-1c · 브랜딩/카피 정리 (zero-human → 사람 중심)
- 분류: `internal` · owner: 기획자 + UI UX · 의존: WC-1
- Acceptance(초안): "zero-human" 전제 문구 재정의 + Workcell→Workcell 점진 브랜딩(README/AGENTS.md/docs/UI 카피). 런타임 영향 있는 `AGENTS.md`는 신중히.
- Proof: 카피 점검 + 빌드 green.
- Plan link: `docs/plan/STRIP_PLAN.md` §TEXT/브랜딩.

### WC-2 · 도메인 모델 & 영속 스키마 (Phase 1 부분)
- 분류: `support` (다운스트림: WC-3/WC-4) · owner: Developer Agent
- Acceptance(초안): Company/Project/Issue/WorkOwner(single)/AgentProfile/Run/ProofBundle/AuditEvent 최소 스키마 + 마이그레이션 + 단위테스트.
- Proof: 마이그레이션 적용 + 모델 CRUD 테스트 green.
- Plan link: PLAN §6 엔터티.

### WC-3 · Kanban Board: 자연어 → 이슈 draft (slice 앞단) `core`
- owner: Developer Agent (+ UI UX Agent 협업) · 의존: WC-2
- Acceptance(초안): 보드 상단 자연어 입력 → 기획자 Agent가 acceptance/non-goals/proof surface/owner role 포함 **Draft 이슈** 생성, 카드에 owner role·single/pair·proof status·decision needed 노출.
- Proof: Playwright — 자연어 입력 후 카드 생성 + 필드 표시. 화면은 experience-first(의도된 UI, 자연스러운 한국어 카피).
- Plan link: PLAN §3/§5.

### WC-4 · Issue Workspace: single-owner 실행 + ProofBundle + Done 게이팅 `core`
- owner: Developer Agent · 의존: WC-2, WC-3
- Acceptance(초안): 이슈를 single owner가 실행해 artifact 생성, ProofBundle 첨부 시에만 Done 활성(QA/QC 권한), 없으면 disabled.
- Proof: Playwright — proof 없는 Done 불가 / proof 첨부 후 Done 가능.
- Plan link: PLAN §5 Issue Workspace, §9 #6.

### WC-5 · Adapter Gateway 최소 + Run 로그 `support`
- owner: Developer Agent · 의존: WC-2
- Acceptance(초안): 최소 1개 adapter 경로(Claude Code 또는 Codex)로 이슈 실행 → Run/transcript/비용 로그 적재.
- Proof: 어댑터 스모크 + Run 레코드 생성 테스트.
- Plan link: PLAN §6 Adapter Gateway.

### WC-6 · 기본 Usage Center (Estimated 우선) `core`
- owner: Developer Agent (+ UI UX Agent) · 의존: WC-5
- Acceptance(초안): Run 비용 집계로 최근 사용량 표시 + `Estimated` 배지. (Synced/Exact는 Phase 4)
- Proof: 사용량 합산 단위테스트 + 화면 표시 Playwright.
- Plan link: PLAN §5 Usage Center, §9 #8.

---

## 다음 wave (미상세)
> 라이브 현재상태는 `CURRENT_STATE.md`(develop @ WC-96)가 권위. 아래는 미착수 후속만.
- Phase 2: PairGroup·Blocked decision 레일·QA/QC gate·Design Dashboard 기본. (Wave 2에서 상세화)
- **pair 워크스페이스 parity (WC-97/103 이후 잔여):** `WORKCELL_PAIR_LIVE_LLM=1` real invoker. **모델 선택 ✅(WC-97).** **기존-워크스페이스 grounding ✅(WC-103:** 이슈의 머터리얼라이즈된 `execution_workspaces.cwd`를 `config.cwd`로 read-only 재사용 — local 어댑터는 `AdapterExecutionTarget` 없이 config.cwd로 cwd 해석. 즉 "안전 부분구현 없음"은 정정됨 — 기존 워크스페이스 재사용은 안전하게 됨). **pair-create UI affordance = 이미 존재**(PairSetupPanel). **남은 = ⓐ 워크스페이스 없는 이슈에 새 worktree 생성** · ⓑ env-secret 해석 · ⓒ 세션 연속성 · ⓓ JWT(에이전트 콜백). **ⓐ 구체 난이도(heartbeat.ts:7227 조사):** `realizeExecutionWorkspace({base, config, issue, agent, recorder})`가 (1) `base`=`resolvedWorkspace`(heartbeat의 프로젝트-워크스페이스 resolution 산물=baseCwd/repo/projectId) 재현 필요 (2) `workspaceOperationsSvc` recorder 필요 (3) **실제 `git worktree` 디스크 작업 수행** → **hermetic 테스트 불가**(fake 없음, 이 Windows env worktree flaky=`spawn sh ENOENT`). ⇒ 이번 루프의 "모든 슬라이스 green hermetic proof" 기준을 충족 못 함 = **전용·리뷰 슬라이스**(자율 부적합). 공통 케이스(기존 워크스페이스)는 WC-103로 커버됨. (P2 §3 #3 잔여.) · owner: Developer Agent · Plan link: `PRODUCT_SPEC.md` §구현 그라운딩(PairGroup).

### Graphify 코드 그래프 통합 (DECISIONS D20, Option-A) — `code` 노드 populator + 외부 MCP 사이드카
- 분류: `support`(다운스트림: Planner/Dev 컨텍스트 탐색) · owner: Developer Agent · 상태: **`Done`(코드 end-to-end) — S1~S4 전부(WC-107~110·WC-121·WC-122); 남은 건 graphify를 실 런타임에 설치하는 배포 선택뿐(코드 아님). S5 KG뷰어 UI=선택 백로그** · Plan link: DECISIONS **D20**/D12, `PRODUCT_SPEC.md`「프로젝트 지식 그래프」.
- **목표:** KG의 **정의됐으나 비어있는 `"code"` 노드 종류**(`server/src/services/knowledge-graph.ts` `NODE_KINDS`, line 20)를 채운다 — 단 **코드 그래프 *생성*은 외부 엔진 Graphify에 위임**(Option A=버전핀 MCP 사이드카, 벤더링 X; B는 Python 전용이라 불가). 미설정 시 graceful fallback(code 노드 0, 기존 동작 byte-불변). 버전 bump→새 그래핑이 MCP 계약 너머로 유입 = OD(D13)와 대칭 "업데이트 혜택" 구조.
- **경계 결정 (A1 vs A2) — A1 우선 권고:**
  - **A1 (ephemeral 쿼리 오버레이, WC-63 패턴 재사용):** 컨텍스트 조립/에이전트 wake 시 Graphify MCP 쿼리 툴(query_graph/get_neighbors/shortest_path)을 호출해 **비영속 포인터 오버레이**로 주입(graph_nodes에 안 씀). `getNeighborhood({enriched})`(WC-63)와 동형 → 위험 최소·Graphify 스키마 비결합.
  - **A2 (영속 ingest):** Graphify graph.json → `code` 노드+엣지로 graph_nodes/graph_edges upsert(기존 REST/MCP 쿼리로 issue 노드와 함께 탐색). 교차세션 영속·구조 쿼리 필요 시. 스키마 결합↑.
  - **권고:** A1 먼저(저위험), 영속 입증되면 A2. (A2의 `ingestCodeGraph`도 hermetic 테스트 쉬움 → 둘 다 점진 가능.)
- **재사용 맵 (실 심볼):** ① `register-mcp-servers.ts` SEEDS에 `code-graph` 시드(env `WORKCELL_CODE_GRAPH_MCP_COMMAND`/`_ARGS`, `python -m graphify.serve <graph.json>`; 설정→active/미설정→pending — graph-enrichment·open-design 동형). ② `knowledge-graph.ts`의 `registerNode`/`registerEdge`/`listNodesByKind` 위 thin layer로 populator 구성. `KnowledgeGraphMcpRegistry.callTool(companyId,mcpKey,tool,args)` + `getNeighborhood({enriched})`가 A1 템플릿. `EDGE_KINDS`(implements/depends_on/references/related)로 Graphify 엣지 매핑. ③ `packages/mcp-bridge`(WC-60) + `mcpClientRegistry`(WC-61, capability-gated)로 Graphify serve 호출.
- **슬라이스 분해 (✅=자율 hermetic green 가능 / ⚠️=실 Graphify 필요):**
  - **S1 ✅ 구현완료(WC-107 `0cfb780`) — `CodeGraphImport` 계약 + `ingestCodeGraph` populator:** 중립 계약 `{ nodes:[{key,label,symbolKind?,filePath?,metadata?}], edges:[{fromKey,toKey,kind?}] }`, `registerNode/registerEdge` 위 idempotent upsert, 엣지 alias, 양끝 미존재 skip. wc28 +6.
  - **S2 ✅ 구현완료(WC-108 `c44871a`) — `code-graph` MCP capability 시드:** register-mcp-servers 3번째 시드(설정→active/미설정→pending). wc64 5/5.
  - **S3 ✅ 구현완료(WC-109 `99ac8fb`) — code-graph 쿼리 오버레이 (A1):** **별도 메서드** `codeGraphNeighbors`(neighborhood 미변경=회귀 0) — 엔진 MCP→ephemeral overlay, WC-63 graceful 동형. wc28 +6.
  - **라우트 ✅ 구현완료(WC-110 `cddcca6`) — 서브시스템 reachable:** `POST .../code-graph/ingest` + `GET .../code-graph/neighbors`. 실 express supertest 7/7. ⚠️최종 e2e=환경 블록(webServer 부하 timeout, 코드 무관).
  - **S4 ✅ 매퍼 구현완료(WC-121 `8c74768`) — graph.json → `CodeGraphImport` 매퍼:** 사용자 unblock("pip install 해도 돼") 후 **실 `graphifyy` 0.8.28 설치 + `graphify update --no-cluster`로 실 export 추출** → 실 스키마(NetworkX node-link: nodes `{id,label,file_type,source_file,…}` · links `{source,target,relation}`, relation=contains/imports_from/imports/calls) 대조 후 `services/graphify-import.ts` `mapGraphifyGraphToImport()` 작성(별칭 추출·pure·never-throws) + `resolveCodeEdgeKind`에 `imports_from`→depends_on·`contains`→related. proof: `graphify-import` 5/5 + wc28 30/30(실 export→map→ingest e2e). **운영 결선 = WC-122로 완료**(아래).
  - **S4 운영 ✅ 완료(WC-122 `1ebf544`) — Graphify 프로듀서 end-to-end:** ⓐ 서버 `POST .../code-graph/ingest-graphify`(raw graph.json→서버측 `mapGraphifyGraphToImport`→ingest, node-link 검증→400). ⓑ CLI `workcell code-graph from-repo --path <repo>`(`graphify update --no-cluster` 실행→graph.json POST; `--graph-json` 사전빌드 주입·`--dry-run`·`--cluster` opt-in; 미설치 graceful). proof: wc110 10/10(+3)·cli code-graph-producer 5/5·typecheck 0·실 graphify 스모크(graph.json 기대경로 생성·relations 4종). **D20 S1~S4 코드 완성**; 남은 건 graphify 런타임 설치(배포 선택).
  - **S5 ⚠️/선택 UI:** code 노드를 KG 뷰어/이슈 컨텍스트에 노출(뷰어 있으면; 없으면 context-injection만).
- **거버넌스:** Graphify 버전 = 특정 git 태그/PyPI 핀(pre-1.0 0.8.x churn). 재지정 = capabilities 라우트(시드 아님). trust tier = `reviewed`(외부 도구), **read-only MCP 툴만**.
- **경계 해소:** **S1~S4 전부 코드 완성**(S1~S3=fake MCP+supertest; S4 매퍼=실 `graphifyy` 0.8.28 export 대조 WC-121; S4 운영=프로듀서 CLI+ingest 라우트+실 graphify 스모크 WC-122). **남은 = graphify를 실 런타임에 설치하는 배포 선택뿐(코드 아님) + S5 선택 KG뷰어 UI.** OD와 동일 dormant→active이되 **연결부까지 코드 완비** — 사용자가 graphify 설치 후 `workcell code-graph from-repo --path <repo>` 한 줄로 실 코드그래프 ingest 가능.

### parentId 쓰기-시점 동일회사 가드 (WC-112 defense-in-depth 후속)
- 분류: `support`(보안 하드닝) · owner: Developer Agent · 상태: `Draft`(저위험 — WC-112가 읽기 누수는 이미 차단) · Plan link: WC-112, DECISIONS D16(엔터티/격리).
- **배경:** WC-112가 `getAncestors`의 cross-tenant **읽기 누수**를 차단(소비자 스코핑, WC-54 패턴). 단 `issues.parentId`(self-FK, 동일회사 제약 없음)에 **cross-company 값이 *저장*되는 것 자체**는 아직 가능: `update`(PATCH)는 가드 없음, `create`는 `getWorkspaceInheritanceIssue` 스코프 가드가 있으나 `inheritExecutionWorkspaceFromIssueId` 동반 시 우회됨(`workspaceInheritanceIssueId = inherit ?? parentId` → parentId 미검증).
- **현 위험도 = 낮음:** WC-112 후 현존 parentId 소비자(`getAncestors`·`syncIssueAsNode`/WC-54·`productivity-review`) **전부 동일회사 스코프** → cross-company parentId는 dangling ref일 뿐 데이터 누수 없음. 가드는 **미래 소비자 회귀 방지**(defense-in-depth) + 데이터 정합.
- **슬라이스:** 공유 헬퍼(예: `assertParentInCompany(tx, companyId, parentId)`, `getWorkspaceInheritanceIssue` 동형)로 `update`(parentId 비-null 세팅 시) + `create`의 우회 분기에서 parent 동일회사 검증, 아니면 `unprocessable`/`notFound`. 테스트: cross-company parentId PATCH/POST → 거부, 동일회사 → 통과. **자율 hermetic 가능**(supertest + embedded-pg, e2e 불요).

### companyService.remove() 캐스케이드 완전성 (WC-116 후속 — 버그헌트 Finding 2)
- 분류: `support`(데이터 정합/삭제) · owner: Developer Agent · 상태: **✅ `Done` — WC-116(주 블로커)+WC-117+WC-118(전 orphan)** · Plan link: WC-116/117/118, DECISIONS D16.
- **해소 완료:** WC-117(`d7d3a97`) budget_policies·budget_incidents·graph_nodes + WC-118(`26d4235`) pair_groups·feedback_votes·workspace_runtime_services·workspace_operations·issue_inbox_archives·issue_thread_interactions·inbox_dismissals → 회사 삭제 전 purge. **전수 FK 감사로 *true orphan*(부모 cascade 없는 non-cascade FK)만 식별** — execution_workspaces(projectId cascade)·company_secret_bindings(secretId cascade)·pair_turns(pairGroupId cascade)·feedback_exports(issueId cascade)·secret_access_events(secretId cascade)·agent_config_revisions(agentId cascade)·document_revisions(documentId cascade)·issue_* 대부분(issueId cascade) 등은 **부모 FK로 이미 cascade**(기존 테스트+감사 확인). proof: cleanup-removal-service 5/5(7개 orphan 시드+회사삭제 green)·typecheck 0.
- **배경:** WC-116이 activity_log 트리거 블로커를 풀어 회사/에이전트 삭제가 동작. 단 `companyService.remove()`(companies.ts:283~328)는 자식 테이블 캐스케이드를 **수동 나열**하는데 몇몇 company-scoped 테이블이 **누락**됨(헌트 지적): `budget_policies`(0032, FK no action — 예산 승인 hire마다 생성)·`budget_incidents`(0032)·`execution_workspaces`(0035)·`company_secret_bindings`(0082)·`knowledge_graph`(graph_nodes/edges, onDelete 없음). 이들 FK가 RESTRICT라 **해당 행이 있는 회사**는 마지막 `delete(companies)`에서 23503 FK 위반 → 삭제 롤백.
- **현 위험도 = 중간:** 예산정책/워크스페이스/시크릿바인딩/KG 노드가 있는 회사만 영향(단순 회사는 WC-116 후 정상 — cleanup-removal-service 통과가 증거, 단 서브셋만 시드). 에이전트 삭제(`agents.ts`)는 해당 누락 없음(확인 필요).
- **전수 FK 감사 완료(2026-06-02, 이 슬라이스의 de-risking 그라운드워크):** `companies.id` 참조 FK 전수 grep. **이미 cascade**(처리 불요): agent_memberships·capabilities(0098)·cloud_upstreams·company_logos·company_secret_provider_configs·company_user_sidebar_preferences·environments·environment_leases·issue_labels·labels·plugin_company_settings·plugin_managed_resources·project_memberships·routines(4)·cli_auth(set null). **non-cascade & remove() 수동목록에 있음**(OK): activity_log·agents·agent_api_keys·agent_runtime_state·agent_task_sessions·agent_wakeup_requests·approvals·approval_comments·assets·company_secrets·company_memberships·company_skills·cost_events·documents·finance_events·goals·heartbeat_runs·heartbeat_run_events·invites·issues·issue_comments·issue_read_states·join_requests·principal_permission_grants·projects. **non-cascade & 목록 누락(잠재 FK위반)**: budget_policies·budget_incidents·execution_workspaces·company_secret_bindings·knowledge_graph(graph_nodes/edges)·pair_groups·pair_turns·feedback_exports·feedback_votes·secret_access_events·agent_config_revisions·document_revisions·heartbeat_run_watchdog_decisions·inbox_dismissals·issue_approvals·issue_attachments·issue_documents·issue_execution_decisions·issue_inbox_archives·issue_recovery_actions·issue_reference_mentions·issue_relations·issue_thread_interactions·issue_tree_holds·issue_tree_hold_members·issue_work_products·project_goals·project_workspaces·workspace_operations·workspace_runtime_services.
- **⚠️핵심 뉘앙스:** 누락 ~30개 중 **상당수는 부모 FK(issueId/agentId/projectId 등)의 cascade로 transitively 삭제됨**(issue_* 다수가 issues 삭제 시 cascade) → 실제 FK위반은 **부모 cascade가 없는 회사레벨 테이블**(budget_*·execution_workspaces·company_secret_bindings·knowledge_graph·pair_*·feedback_*·secret_access_events 등)만. **blind cascade-all 위험**: 어떤 테이블을 cascade하면 그 **자식 RESTRICT FK**(예 graph_edges→graph_nodes, workspace_*→execution_workspaces)가 새 위반 유발 가능.
- **권장 슬라이스(test-driven, 자율 hermetic):** cleanup-removal-service에 위 회사레벨 누락 테이블(+자식) 시드 추가 → 회사 remove() 실행 → FK위반하는 테이블만 식별 → 0098 패턴(`ALTER … ON DELETE cascade`, 자식까지 전 subtree)으로 마이그레이션 또는 의존성 순서 수동 delete 추가 → green까지 반복. **전 subtree cascade 확인 필수**(자식 RESTRICT FK 새 위반 방지). 급조 금지 — 이 감사를 토대로 신중 실행.

## 기록 (Done/Cancelled/Archived)
- (없음)
