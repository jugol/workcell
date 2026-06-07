# Workcell — 기본 계획 (PLAN)

> 1차 source of truth는 `../../기본 기획서.md`(상세 기획서). 본 문서는 그 기획서를 구현용으로 정리한 **활성 계획**이다.
> 우선순위: 기획서 → 본 PLAN 세트 → 이슈 명세 → API/DB 계약 → UI 상세 설계.
> 계획 변경은 문장으로 끝내지 말고 PLAN/PLAN_ANCHOR/acceptance/non-goals/proof에 반영하고 `DECISIONS.md`에 기록.

## 1. 제품 정의

Workcell은 **사용자가 방향을 정하고 AI 에이전트들이 회사처럼 실행하는 범용 프로젝트 운영 플랫폼**이다. 세 기둥을 결합한다:

- **Paperclip control plane** — 조직도/예산/거버넌스/티켓/불변 audit log/멀티컴퍼니 격리/작업 기반 영속.
- **issueflow 실행 철학** — 계획을 기능 나열이 아닌 *목표 경험 → 이슈 → 증거*로 연결, vertical slice, 로컬 proof 우선.
- **Open Design 디자인 capability** — preview·artifact·read-only MCP를 sidecar로 공급.

목표 구조: **운영은 회사처럼, 실행은 이슈처럼, 판단은 인간이.** (무인 회사가 아니라 사람 중심 실행 보조)

## 2. 레퍼런스 / 차별화 (요지)

- Paperclip의 control plane(BYO agent, org chart, heartbeat, budgets, governance, tickets, audit, isolation)은 계승하되, 비전은 "zero-human"이 아니라 **사람이 board/창업자**인 모델로 재정의.
- 거버넌스 = 사람을 제거하는 승인이 아니라 **사람의 시간을 핵심 의사결정에 집중**시키는 승인. → release sign-off, blocked 이슈 승인, skill/plugin/MCP 설치 승인, plan conflict 승인을 핵심 UX로 노출.
- issueflow: GitHub는 추천(감사 계층)이되 필수 아님 — 실행 기준은 **로컬 명령/proof/계획 문서**. active context는 얇게 유지, blocked 자동화는 삭제 말고 PAUSED.
- pair work 근거: Self-Refine / Reflexion / Multiagent Debate / sparse topology → **무한 토론 금지, 최대 10라운드·명시 stop·비용 상한**의 2인 루프.

## 3. 범용 운영 모델

- 기본 단위는 repo가 아니라 **Project**(코드 저장소·트래커·디자인 작업공간·배포 대상·문서를 선택적으로 연결). 소프트웨어 외 콘텐츠/디자인/마케팅/세일즈/CS 운영에도 적용.
- **신규 bootstrap:** Planner가 목표 사용자/상황/불편/도움 순간/이후 가능/first workflow/비목표 정리 → `PLAN.md`,`PLAN_ANCHOR.md` → stack/topology 결정 → local backlog → first issue wave(얇은 end-to-end vertical slice 포함) → local proof entrypoint.
- **기존 bootstrap:** repo/트래커/PR/화면/테스트/문서/디자인/백로그 스캔 → `CURRENT_STATE.md`,`BACKLOG_BOARD.md` 생성 → 열린 작업을 `aligned|extension|conflict|deviation` 분류 → 방향 바꾸는 질문만 좁게.
- **자연어 → 이슈:** 항상 자연어에서 시작. 이슈는 메모가 아니라 acceptance criteria/non-goals/proof surface/계획 링크/예상 owner role/blocker 보유. broad request는 독립 이슈로 분해.
- **칸반 상태 모델:** `Draft, Ready, In Progress, In Review, In QA, Blocked by User, Blocked by System, Done, Cancelled, Archived`. Done/Cancelled/Archived는 숨김 가능, `Blocked by User`는 별도 집중 레일.

## 4. 에이전트 체계 + 페어워크

기본 역할(직함이 아니라 **업무 흐름** 중심):

- **기획자 Agent** — 자연어/계획/백로그/화면/이슈/proof 종합 → 계획 수립, gap을 이슈로 환원. 남이 일한다고 멈추지 않음. 계획 문서는 **§4.5 방법론**(SPEC·implemented·TODO, 500줄 cap, 불필요는 삭제)대로만 관리하며, 이슈 생성/완료와 함께 implemented·TODO를 동기화. 완료 후 **Compound 단계**(D19) 주관: implemented/+그래프 갱신·학습/예방 흡수·후속 이슈 환원(새 문서 종류 X).
- **UI UX Agent** — Design Dashboard를 source of truth로 유지. 화면 추가/변경 시 항상 호출, deprecated는 archive. 첫 뷰포트·시선·카피·톤·정보계층 검토. **Open Design pack 기본 탑재**, preview 우선.
- **Developer Agent** — 기본 "한 번에 한 feature 이슈". 팀엔 여러 Developer lane 가능, 독립 vertical slice는 **병렬 worktree**. monorepo는 package-local proof + disjoint ownership 메타데이터.
- **QA / QC Auditor** — 독립 완료 판정자. **proof bundle 있을 때만 Done.** 프로젝트별 QA 방법론을 `QA_PLAYBOOK.md`에 축적(Playwright/golden/qualitative).

확장 역할(프로젝트별): Strategist/Researcher/Writer(콘텐츠), Prospector/Signal Analyst/CS(세일즈·운영) — 모두 issue owner 후보 + proof 남기는 역할.

- 모든 Agent는 자연어로 성격 변경 가능, 고급 사용자는 system prompt 직접 편집. 2층 관리: **Role Charter** + **Behavior Prompt**, 변경은 버전·롤백 보유.
- **Pair work:** `WorkOwner = SingleAgent | PairGroup`. PairGroup = 두 member + 공유 charter, 라운드 루프(A draft → B critique/edit → A …), `no_change_required`/maxRounds=10/budget/human/blocked로 종료. 산출: 최종 artifact, 라운드별 diff·feedback, stop reason, 총 비용. **한 이슈 owner는 여전히 하나.**

## 4.5 프로젝트 계획 문서 방법론 (PlanSet)

> 상세 source of truth = `../../기본 기획서.md` 「프로젝트 계획 문서 방법론」.

Workcell이 관리하는 모든 프로젝트의 계획은 **세 문서로만** 표현한다(완료/미완료 이슈 히스토리 누적·재독 금지). 트리에서 필요한 파일만 읽어 "남은 것 vs 현재 스펙"을 비교한다.

- **SPEC** — 전체 기획(source of truth). 확정 결정은 별도 로그 없이 여기 흡수.
- **implemented/** — 구현된 것. 큰 피쳐별 폴더 트리, **파일당 ≤500줄**, 파일명=내용, 현재 상태의 압축 스냅샷, 얇은 `INDEX.md`.
- **TODO** — 남은 것 = SPEC − implemented. 최상단=활성 이슈/다음 행동. 미확정 결정은 "결정 대기" → 확정 시 SPEC 반영 후 삭제.

**HARD RULES:** ① 이 셋이 계획·결정·이슈관리 문서의 전부(그 외 ad-hoc 문서·기억 방식 금지; `DESIGN_DASHBOARD`·`QA_PLAYBOOK`만 예외, 동일 규율). ② 이슈관리 문서 **500줄 절대 상한**, 압축 최우선. ③ 불필요는 요약·아카이브 말고 **삭제**(히스토리 누적 금지). ④ 작은 요청(스펙 불변)이면 안 건드림 — 스펙 변경 시에만 SPEC·implemented·TODO 동반 유지보수. 기획자 Agent가 이슈 생성/완료와 함께 동기화.

## 4.6 프로젝트 지식 그래프 (코드·기획 인덱스)

> 상세 = `../../기본 기획서.md` 「프로젝트 지식 그래프」. 결정 = `DECISIONS.md D12`.

문서(SPEC/implemented/TODO)는 디테일·최소, 그 위에 **단일 경량 지식 그래프**(코드+기획+결정+이슈참조)=현재상태 탐색 인덱스. 노드=포인터만(본문 복제X), 엣지=implements·depends-on·status.
- **파생·재사용:** 권위 소스에서 파생(불일치 시 소스 우선). 기존 `issue_relations`(blocks)·`issue_reference_mentions`(이슈 링크) 엣지 재사용, `plugin-llm-wiki` distillation을 populator로 재사용, 코드는 Graphify식.
- **대체:** llm-wiki 내비게이션(index.md+backlinks+standup)을 정식 그래프가 승계(wiki-maintainer=그래프 유지자). 키워드 검색(company-search, 임베딩 없음)은 보완 공존.
- **touchpoints:** MCP 신규 도구(graphQuery/Neighbors/Upsert) + heartbeat-context에 관련 포인터 주입 + 이슈 생성/완료 시 갱신. Planner=생성 전 현황, Dev/QA=관련 코드·문서 탐색.
- **충돌 없음:** 이슈 진실원=DB/Kanban, 그래프는 ID 참조만. 시간축 보류(audit log). 백엔드 경량(Postgres+AGE/pgvector, 새 DB 없이), 확정 P3 PoC.

## 4.7 Open Design 통합 (디자인 capability)

> 상세 = `../../기본 기획서.md` 「Open Design 통합」. 결정 = `DECISIONS.md D13`.

**Open Design**(nexu-io, Apache-2.0; CLI 에이전트=디자인 엔진, `<artifact>` iframe 프리뷰, read-only MCP, BYOK)을 **플러그인(capability pack)+사이드카**로 이식 — 코어 포크/어댑터 아님(엔진이 Workcell 어댑터/워크스페이스와 겹침).
- **플러그인**(plugin-llm-wiki 템플릿): UX agent 도구 + 디자인 Skills/`DESIGN.md` 시스템(BYOK) + Design Dashboard(`page` 슬롯, 라우트 `design`) + 이슈 `detailTab` + 영역주석(`commentAnnotation` 재사용) + `dashboardWidget`.
- **생성**=Workcell 어댑터/Run Orchestrator(OD 데몬 미사용). **프리뷰**=샌드박스 iframe 런처 재사용(in-process 슬롯 금지).
- **아티팩트**=기존 `issue_work_products`+`assets` 증강(새 코어 테이블 X). **외부 MCP 브리지**=유일 net-new(현재 outbound MCP 없음); (b) claude/codex 어댑터에 OD MCP 직접 부착이 경량 — **지식 그래프 MCP와 공유**.
- UX `designer` 역할 이미 존재(`uxdesigner.md`, Visual-truth gate) → 증강(대체 아님, 디자인 기능 그린필드). 라이선스 Apache-2.0(번들 시 NOTICE). P2(대시보드 기본)→P3(브리지/MCP).

## 5. 핵심 화면 (5)

1. **Project Home** — 목표 경험·활성 이슈·blocked·최근 proof·비용 신호 요약.
2. **Kanban Board** — 운영 화면. 상단 자연어 입력창, 카드엔 owner role·single/pair·proof status·design impact·decision needed·usage burn 우선 노출. 상태 필터 + `Blocked by User` 집중 레일.
3. **Issue Workspace** — 왜 존재하는가 + 무엇으로 끝났는가. classification/acceptance/non-goals/plan link/owner/deps/planned proof + artifact 버전·diff·preview·annotation·run transcript·pair turns·audit. Done 버튼은 QA/QC 권한 + proof bundle 있을 때만.
4. **Design Dashboard** — UI UX Agent의 source of truth. current/deprecated 화면, 버전 비교, 승인, linked issues/components, iframe preview, 영역 코멘트.
5. **Capabilities / Usage Center** — skills/plugins/MCP/design systems registry(visibility: assigned/discoverable/hidden/disabled, role별 기본 노출 최소화) + Usage(Exact/Synced/Estimated 배지).

## 6. 아키텍처 / 데이터 계약 (요지)

- **전략:** Paperclip 포크 + 도메인 재정의 + 외부 능력 sidecar/bridge. (상세/대안은 `DECISIONS.md` D1)
- **계층:** Control Plane API, Planner/Scheduler, Run Orchestrator, Adapter Gateway(Claude Code/Codex/CLI/HTTP/MCP bridge), Capability Registry, Design Sidecar Bridge(Open Design), Usage Telemetry, Context Manager, Audit/Observability.
- **핵심 엔터티:** Company, Project, PlanSet(SPEC·implemented/·TODO — §4.5, +역할산출물 DESIGN_DASHBOARD·QA_PLAYBOOK), Issue, WorkOwner(single|pair), AgentProfile, PairGroup, Run/PairTurn, Artifact/ArtifactVersion/Annotation, ProofBundle, Capability/CapabilitySource/CapabilityAssignment, UsageSnapshot, ContextShard/CompactionRun, DecisionRequest. — **Issue assignee는 하나, owner가 single|pair.**
- **컨텍스트 4-plane:** Role Charter / Working Memory / Episodic Memory / Capability Index. 기본은 index+pointer만 로드, on-demand fetch, PreCompact/PostCompact 활용.
- **확장 3계층:** trusted platform modules / plugins(out-of-process) / skills·MCP·design systems. 3rd-party UI는 same-origin 마운트 금지 → iframe/webview/typed bridge.
- **업데이트:** 자동이 아니라 **사용자 트리거형 staged update**(upstream pin → manifest/license diff·smoke·breaking risk 표시 → apply 승인, company/agent scope 분리).

## 7. 과금 / 보안 (요지)

- **과금:** 최종 사용자에겐 **구독형 단일 상품(seat/workspace)**, 내부적으로 provider 비용·rate limit·credit·burn 추적. "가격은 구독으로 단순화, 운영은 usage-aware로 정교화."
- **보안:** capability별 trust tier `trusted|reviewed|unreviewed`. unreviewed = auto-invoke 금지·기본 disabled·승인 필요·UI bridge 격리·secret 접근 금지. secret은 manifest 금지, company-scoped secret store만. 설치/업데이트/권한승인 전부 audit.

## 8. 로드맵 (요약)

상세는 `ROADMAP.md`. P1 single-owner 실행 코어 → P2 pair/QA gate/design dashboard → P3 Open Design bridge/capability/compaction → P4 enterprise hardening.

## 9. MVP 수용 기준

> Phase 1 진행 상태: ✅=user-visible 구현, 🟡=일부, 🔲=미구현. (2026-05-29 기준, `CURRENT_STATE.md`로 상시 동기화)

1. ✅ 신규/기존 프로젝트 bootstrap — 신규 onboarding 위저드 ✅, ingest API ✅(WC-41), 클라이언트 CLI 스캐너 ✅(WC-48 `workcell bootstrap from-repo`: README/package.json 파싱, 프로젝트명·설명·TODO 추출, --dry-run).
2. ✅ 자연어 요청 시 Planner가 ongoing 무관하게 draft/ready 이슈 생성 (WC-2).
3. ✅ WorkOwner=single/pair — single ✅, pair full stack ✅ **+ commercial-grade(2026-06-02)**: substrate(WC-23~26), driver loop(WC-32 + run-round route), prompt-aware executor(WC-33), UI chip(WC-34), 타임라인(WC-46). **실 LLM invoker**(WC-58, flag) + **commercial-grade 6축**: 모델선택(WC-97)·env-secret resolve(WC-125)·타임라인 투명성 live/simulated·총비용·stop reason(WC-126)·수렴까지 실행(WC-127)·동시 run-round race 가드(WC-128)·**파일편집 격리 worktree D21**(WC-130~133: realize seam→ensurePairWorkspace→executor 배선→완료시 cleanup, heartbeat lease/JWT 무회귀). live 운영=`WORKCELL_PAIR_LIVE_LLM=1`+`WORKCELL_PAIR_LIVE_WORKSPACE=1`. 남은=선택적(시스템 전역 idle-workspace reaper 부재=parity).
4. ✅ UI UX Agent의 Open Design preview — 플러그인 스캐폴드 ✅(WC-31), artifact 리스팅 라우트 ✅(WC-40), UI artifact 카드 ✅(WC-47), **version diff + sandboxed iframe preview ✅**(WC-49 — Preview 버튼이 sandbox="allow-same-origin" iframe 전환, Compare 버튼이 next-older sibling과 line diff 패널, +/- 컬러링). 남은(out-of-scope) feature: image pixel diff, outbound MCP bridge(D12 공유 별건 슬라이스).
5. ✅ Developer Agent 이슈 단위 vertical slice — single-owner ✅, parallel-dispatch candidate detection ✅(WC-42), **자동 dispatcher ✅**(WC-44 POST /companies/:id/parallel-dispatch-candidates/wake — 병렬 wakeup 실행, per-issue ok/error 리포팅, maxToDispatch cap, source="automation" audit trail). **per-agent budget cap ✅**(이미 구현·검증됨: budget_policies generic scope[company/agent/project], budgets.ts agent-scope spend 평가, heartbeat가 `getInvocationBlock(companyId,agentId,…)`로 invocation 차단, budgets-service.test agent+company 양 scope 커버 — 위 "남은 갭" 노트는 stale).
6. ✅ QA/QC Auditor proof 없이 Done 불가 + qualitative 판정 — proof-gate(WC-3/7) + 기본 QA 정책 자동 주입(WC-5/6).
7. ✅ Capability Registry company/agent scope — substrate ✅(WC-27), HTTP 라우트 ✅(WC-30), UI 페이지 ✅(WC-35), 승인 액션 ✅(WC-36), 라우터 wiring ✅(WC-38), **visibility-aware effective listing ✅**(WC-45 GET .../agents/:id/effective-capabilities — active+!hidden+scope-match 필터, deprecated 포함, name 정렬).
8. ✅ Usage Center provider별 Exact/Synced/Estimated 배지 — Costs 페이지에 ProviderQuotaCard + WC-20 confidence chip(emerald/amber/muted) 노출. 최근 사용량/잔여량/경고는 기존 BillerSpendCard/Budget bars로 통합. quotaConfidence(source) 헬퍼로 anthropic-oauth/claude-cli/codex-rpc=Exact, codex-wham/bedrock=Synced, 나머지=Estimated.
9. ✅ PLAN_ANCHOR/CURRENT_STATE/capability index compaction — anchor/현재상태 rolling 유지 ✅, on-demand compaction backend ✅(WC-37), **IssueDetail "Compact context" 버튼 ✅**(WC-43 — executionRunId 있을 때만 노출, success toast + documents 캐시 invalidate, no_run_available 에러 분기 한국어 메시지).
10. ✅ 모든 mutating action audit 조회 — activity_log 기반 + 불변 강제(WC-29: BEFORE UPDATE/DELETE 트리거, "append-only" 에러 메시지, TRUNCATE는 테스트 정리용으로 허용). 5✅ 도달.
11. ✅ **Compound 단계 — 1st + 2nd 사이클 자동화 완료.** proof-gated Done 후 compound-checklist 자동 생성(WC-12) → follow-up 불릿이 실제 backlog 이슈로 환원(WC-13) + UI "Process follow-ups" 트리거(WC-14) + lineage 칩(WC-18) + e2e(WC-15) → **LLM-driven 자동 fill**(WC-19, Planner-capable agent에게 compound child 위임, instruction 프롬프트로 sections 1-4 작성, section 5 보존) → **Done 전이 시 자동 트리거**(WC-21, 사용자는 mark-done만 하면 Compound 사이클 자동 가동). 새 문서 종류 신설 없이(D11) 일반 이슈 문서로 정착. **남은 갭:** implemented/+그래프 자동 갱신(P3 D12 지식 그래프와 결합 예정).
