# Workcell — DECISIONS (결정 로그)

> 계획 변경/아키텍처 결정의 단일 기록처. 각 항목: 상태(`confirmed`=기획서 기반 확정 / `proposed`=확인 필요) · 결정 · 근거 · 영향.
> `proposed` 항목은 **첫 구현 이슈 dispatch 전에** 사용자 확인을 받는다.

## D1 — 구현 전략: Paperclip 포크 → strip → Workcell 도메인 재정의
- **상태:** confirmed (2026-05-25, 사용자 확정)
- **결정:** Paperclip을 **포크**해 control plane을 베이스로 삼고, **불필요한 부분을 점진적으로 걷어내며(strip)** Workcell 도메인으로 재정의한다. pair/design dashboard/capability governance를 core domain으로 편입, Open Design·MCP·외부 plugin은 sidecar/bridge로 연결.
- **근거:** Paperclip이 이미 Node.js server + React UI + task/governance/budget/audit/adapters/plugins를 제공 → 처음부터 짓는 것보다 빠르고 리스크 낮음. pair는 execution owner 모델 변경이라 core 편입 필요.
- **strip 방향(초기):** zero-human 지향 전제/문구, 현재 Workcell에 불필요한 어댑터·기능·UI 식별 후 제거. 구체적 strip 대상 식별·제거는 WC-1에 포함.
- **후속(WC-1에서 처리):** (a) 포크 베이스 커밋/태그 핀, (b) upstream 추적 방식(예: upstream remote 유지 + 주기적 diff 검토), (c) 라이선스 확인.

## D2 — 협업 계층: GitHub는 선택(추천), 로컬 우선
- **상태:** confirmed (기획서/issueflow 철학)
- **결정:** 실행 기준 = 로컬 명령/proof/계획 문서. GitHub 연결 시 durable issue ID·PR·review·required checks를 audit 계층으로 사용. 부트스트랩은 **로컬 우선**(`docs/BACKLOG_BOARD.md`)으로 시작하고 `.github/` 템플릿은 미리 준비.
- **영향:** 백로그는 로컬 파일 보드. GitHub 채택 시 동일 구조를 이슈/PR로 매핑.

## D3 — 이슈 소유: single-assignee + WorkOwner(single|pair)
- **상태:** confirmed
- **결정:** 한 이슈의 top-level owner는 하나. pair는 owner 내부의 실행 모드(2인 라운드 루프).
- **근거:** Paperclip single-assignee 단순성 유지 + pair 품질 확보.

## D4 — 페어 루프 경계
- **상태:** confirmed
- **결정:** maxRounds=10, stop reason ∈ {converged, max_rounds, budget_stop, human_stop, blocked}, 라운드별 diff·feedback·비용 기록.

## D5 — 컨텍스트: index/pointer 우선 + on-demand + compaction
- **상태:** confirmed
- **결정:** full skill body/archive/과거 proof를 기본 preload 금지. Role Charter/Working/Episodic/Capability Index 4-plane. 앵커·현재상태 얇게 유지(150~250줄), 초과 시 compaction → `docs/history/`.

## D6 — Capability 신뢰 등급
- **상태:** confirmed
- **결정:** trust tier `trusted|reviewed|unreviewed`. unreviewed = auto-invoke 금지·기본 disabled·승인 필요·UI bridge 격리·secret 접근 금지. 3rd-party UI는 same-origin 마운트 금지(iframe/webview/typed bridge). secret은 company-scoped store만.

## D7 — Usage 정확도 배지
- **상태:** confirmed
- **결정:** provider 수치는 `Exact|Synced|Estimated` 배지로 출처/신뢰도 표기. 가격은 구독형 단일 상품, 운영은 usage-aware.

## D8 — 서브에이전트/병렬 권한
- **상태:** confirmed
- **결정:** 기본 "명시 승인 필요". 병렬 lane/worktree는 `issueflow parallel`(또는 이를 인용한 current-state) 있을 때만. lane이 독립이어도 권한 없으면 pause/질문, 겹치면 serialize + 사유.

## D9 — 문서/카피 언어: 한국어
- **상태:** confirmed
- **결정:** 계획·운영 문서·제품 카피 기본 한국어(유창한 모국어 톤). 코드 식별자/표준 라벨은 영어 허용.

## D10 — 저장소 루트
- **상태:** confirmed (2026-05-25)
- **결정:** git 저장소 루트 = `C:\Claude_Project\Workcell`. Git Flow-lite: `main`(릴리스) / `develop`(통합) / `issue/*`. 2026-05-25 `git init` + 초기 스캐폴드 커밋 + `develop` 생성 완료. (2026-05-27 전면 리브랜드 후 단일 `init: Workcell`로 히스토리 스쿼시.)

## D11 — 프로젝트 계획 문서 방법론(PlanSet) 재정의
- **상태:** confirmed (2026-05-27, 사용자 확정)
- **결정:** Workcell **제품**이 프로젝트를 관리할 때의 PlanSet을 **`SPEC`(전체 기획·source of truth) · `implemented/`(구현된 것, 피쳐별 ≤500줄 폴더 트리) · `TODO`(남은 것 = SPEC − implemented)** 세 종류로만 구성. 확정 결정은 SPEC에 흡수(별도 로그 폐지), 미확정은 TODO '결정 대기'.
- **하드룰:** 이 셋이 계획·이슈관리 문서의 전부(ad-hoc 문서·기억 방식 금지), 문서 **500줄 절대 상한**·압축 우선, 불필요는 삭제(완료/미완료 히스토리 누적·재독 금지), 작은 요청은 미수정·스펙 변경 시에만 동반 유지보수. 기획자 Agent가 이슈 생성/완료와 함께 동기화.
- **근거:** 중간 부산물(결정·이슈노트) drift와 문서 비대화 방지. 트리에서 필요한 파일만 읽어 '남은 것 vs 현재 스펙' 비교.
- **반영처:** `기본 기획서.md` 「프로젝트 계획 문서 방법론」(canonical) · `docs/plan/PLAN.md §4.5`.
- **범위:** 제품 스펙 정의에 한함. 본 저장소의 dev용 issueflow 문서(`PLAN_ANCHOR`/`CURRENT_STATE` 등)는 이번 변경 대상 아님(사용자 명시).

## D12 — 프로젝트 지식 그래프: 단일 경량 인덱스 (문서 최소 + 코드·기획 그래프)
- **상태:** confirmed (2026-05-27, 사용자 확정)
- **결정:** 계획 문서(SPEC/implemented/TODO)는 디테일·최소 유지, 그 위에 **단일 경량 지식 그래프**(코드 + 기획/스펙 + 결정 + 이슈참조)를 **현재상태 탐색 인덱스**로 둔다. 목적=기억이 아니라 *탐색*(다 안 읽고 필요한 분야만 골라 로드). 노드는 디테일(문서 섹션·`file:line`·이슈 ID) **포인터**만 보유(본문 복제 금지).
- **충돌 방지 (핵심):** 이슈 추적 진실원은 **DB/Kanban(`Issue` 엔터티) 그대로** — 그래프는 이슈를 **ID 참조만** 하고 상태·생명주기 재저장 안 함(이중 추적 금지). 그래프 = 이슈 DB·코드·계획 문서에서 **파생되는 읽기 인덱스**(불일치 시 소스 우선).
- **기존 자산 재사용/대체 (2026-05-27 코드베이스 조사 반영):** ① `issue_relations`(blocks)·`issue_reference_mentions`(이슈↔이슈 자동 링크) = 이미 엣지 테이블 → depends-on/relates-to로 흡수(병렬 저장 금지). ② `plugin-llm-wiki`의 **distillation 파이프라인**을 그래프 **populator**로 재사용. ③ llm-wiki **내비게이션 레이어**(`index.md`+`[[wikilink]]` backlinks+project standup)를 그래프가 **승계**(wiki-maintainer=그래프 유지자로 재정의). ④ 키워드 검색(`company-search`, trigram; **벡터/임베딩 없음**)은 **보완 공존**(그래프=구조, 검색=텍스트).
- **Agent touchpoints:** (1) **MCP 그래프 도구** `graphQuery/graphNeighbors/graphUpsert` 신설(현재 MCP엔 검색/지식 도구 없음). (2) **heartbeat-context**(이슈 wake 번들, `server/src/routes/issues.ts`)에 그래프 파생 관련 포인터 주입. (3) 이슈 생성/완료 이벤트 시 갱신. Planner=생성 전 현황, Dev/QA=관련 코드·문서·이슈 탐색.
- **시간축(Graphiti식)은 보류:** "언제 뭐 바뀌었나"는 불변 audit log가 담당 + D11(삭제·비누적)과 충돌하므로 채택 안 함. 필요 시 P3에서 옵션 레이어로.
- **백엔드(경량 우선, P3 PoC):** 임베디드 Postgres 위 그래프 스키마/Apache AGE + pgvector(새 DB 없이). 코드 그래프화는 Graphify식 도구 차용. Neo4j/FalkorDB·시맨틱 메모리 스토어는 미채택(현재 시맨틱 메모리·context compaction 미구현 — 그린필드).
- **반영처:** `기본 기획서.md` 「프로젝트 지식 그래프」 + `docs/plan/PLAN.md §4.6` + `ROADMAP.md` P3.

## D13 — Open Design 통합: 플러그인 capability pack + 사이드카 MCP 브리지
- **상태:** confirmed (2026-05-27, 코드베이스 조사 반영)
- **결정:** **Open Design**(`nexu-io/open-design`, Apache-2.0)을 **Workcell 플러그인(capability pack) + 사이드카 브리지**로 이식. **코어 포크/어댑터 아님** — OD 엔진(CLI 에이전트+스킬+워크스페이스+오케스트레이션)이 Workcell이 이미 가진 것과 겹치고, 빌트인 어댑터는 잠겨 있으며 어댑터 계약(`ServerAdapterModule.execute`)은 "에이전트 프로세스 런타임"이라 OD(엔진/MCP/아티팩트 소스)와 부적합.
- **이식점(코드 조사):** ① **플러그인**(`plugin-llm-wiki` 템플릿) — UX agent tools + 디자인 Skills/`DESIGN.md` 시스템(BYOK=`secrets.read-ref`) + Design Dashboard(`page` 슬롯, 라우트 `design`/`screens`) + 이슈별 아티팩트(`detailTab`/`taskDetailView`) + **영역 주석=기존 `commentAnnotation` 슬롯** + `dashboardWidget`. ② **생성=Workcell 어댑터/워크스페이스/Run Orchestrator**(OD 데몬을 제2 오케스트레이터로 X). ③ **프리뷰=샌드박스 iframe**(기존 `/_plugins/:id/ui/*` 런처 + asset CSP `sandbox` 재사용; in-process React 슬롯은 신뢰불가 HTML이라 금지). ④ **아티팩트=기존 `issue_work_products`+`assets` 증강**(스펙 `Artifact/Version/Annotation` 매핑, 새 코어 테이블 금지). ⑤ **외부 MCP 브리지=유일 net-new 인프라**(outbound MCP 클라이언트 없음): (a) 플러그인 worker `http.outbound`/신규 MCP 클라이언트 또는 (b) claude/codex 어댑터에 OD read-only MCP 직접 부착(CLI가 MCP 네이티브, 코어변경 0 가능) — **(b) 우선, 지식 그래프(D12) MCP와 공유**.
- **기존 역할 재사용:** UX `designer` 에이전트 이미 존재(`skills/workcell-create-agent/references/agents/uxdesigner.md`, "Visual-truth gate"=뷰포트 렌더+스크린샷 의무) → OD가 엔진 공급(augment).
- **대체 대상:** 없음 — Workcell엔 디자인 기능 자체가 없음(Design Dashboard·프리뷰·아티팩트버전·outbound MCP 모두 그린필드) → **증강**.
- **라이선스:** Apache-2.0 — 스킬/디자인시스템 번들/포팅 시 `NOTICE` 귀속 추가, 외부 사이드카 실행만 하면 경량.
- **리스크:** outbound MCP config 스키마 전무 → 처음부터 설계(주요 리스크). 빌트인 어댑터 잠김·예약 라우트(`design-guide` 등)·in-process 슬롯 비적합 주의.
- **시퀀싱:** P2(Design Dashboard 기본 + UX agent) → P3(OD 브리지 + outbound MCP + capability registry). **반영처:** `기본 기획서.md`「Open Design 통합」 + `PLAN.md §4.7` + `ROADMAP.md` P2/P3.

## D14 — 구현 그라운딩 (Paperclip 코드 이식 지도: PairGroup·Usage·화면)
- **상태:** confirmed (2026-05-27, 코드베이스 조사)
- **5개 화면:** 그린필드 제품 레이어 + 도너 — Issue Workspace←`IssueDetail.tsx`(최강), Kanban←`KanbanBoard.tsx`/`IssuesList.tsx`, Project Home←`Dashboard.tsx`/`ProjectDetail.tsx`, Design Dashboard·Capabilities/Usage=빌드(도너 `Costs`/`CompanySkills`/`PluginManager`/`CommentThread`). **Phase 1 핵심 갭=자연어→Planner 초안**(현 이슈 생성은 순수 CRUD). 새 1차 개념(proof bundle·owner role·single/pair·design impact·decision·usage burn·`Blocked by User` 레일)은 코드에 없음.
- **PairGroup:** 한 라운드=기존 `adapter.execute`/`heartbeat_runs` 1회. 재사용 transcript diff/cost·세션·비용·wakeup. net-new=라운드 루프 오케스트레이터+`PairTurn` 원장+`WorkOwner` 인디렉션(단일 `assigneeAgentId`→pair).
- **Usage Center ~70% 기구현:** `getQuotaWindows()`가 구독/OAuth provider quota를 이미 sync(claude=Anthropic OAuth/Claude CLI, codex=app-server RPC/ChatGPT WHAM). 배지=`Synced/Exact`(구독 quota)·`Estimated`(어댑터 burn; metered API-key는 sync 불가=구조적 Estimated). net-new=정식 provenance enum+통합 IA+(선택)`UsageSnapshot`. `Costs.tsx`에서 진화.
- **반영처:** `기본 기획서.md`「구현 그라운딩」. 시퀀싱 영향 없음(P1 single-owner → P2 pair/Usage/Design → P3 graph/OpenDesign 유지).

## D15 — 구현 그라운딩 2: charter · capability registry · trust tier · bootstrap (코드 기준)
- **상태:** confirmed (2026-05-27, 코드베이스 조사)
- **charter/instructions:** 재사용 `agentInstructionsService` 파일 번들(`AGENTS.md` NL 편집)+`agent_config_revisions`. net-new=charter↔behavior 2층+프롬프트 본문 버전/rollback. ⚠️ 현 rollback은 config 행만 복원, **`AGENTS.md` 본문은 스냅샷에 없음**.
- **capability registry:** 3계통 분산(skills/plugins/MCP), 배정은 `adapterConfig.workcellSkillSync.desiredSkills`로 암묵. net-new=통합 registry+가시성 enum(assigned/discoverable/hidden/disabled)+scope 테이블. evolve `company-skills.ts`.
- **trust tier:** 재사용 secret store(`company_secrets`/`company_secret_bindings`)+`secret_access_events` 감사+플러그인 capability 승인 게이트(`plugin-lifecycle.ts`). net-new=`trusted|reviewed|unreviewed`+강제 번들. ⚠️ **`company_skills.trustLevel`=콘텐츠 위험 클래스, 보안 등급 아님 — 혼동 금지(새 필드)**.
- **bootstrap(최대 그린필드):** 현재 수동 CRUD+company import/export뿐, Planner/repo-scan bootstrap 전무. net-new=Planner 주도 신규(plan/anchor/backlog/proof+wave)·기존(repo 스캔→current-state). evolve hook=`createProject`/`OnboardingWizard`, 스캔=`company-skills` repo-scan.
- **반영처:** `기본 기획서.md`「구현 그라운딩」. 시퀀싱: bootstrap+charter 기초=P1, registry/visibility+trust tier=P3.

## D16 — 구현 그라운딩 3: 엔터티 정합 · 이슈 상태 · 승인/거버넌스 (코드 기준)
- **상태:** confirmed (2026-05-27, 코드베이스 조사; 66 테이블)
- **엔터티:** 척추(Company/Project/Issue/AgentProfile/Run=heartbeat_runs/cost/skill/plugin) 풍부히 존재. **net-new 협업+proof 레이어:** WorkOwner·PairGroup·PairTurn·ProofBundle·ContextShard·CompactionRun·UsageSnapshot·ArtifactVersion·CapabilitySource/Assignment. Artifact=`issue_work_products`+`assets`, Annotation=`issue_comments` 매핑(새 테이블=`ArtifactVersion`만). ⚠️ 현 이슈 **엄격 single-owner**(`assigneeAgentId` XOR `assigneeUserId`) — pairing 발판 없음.
- **상태 모델:** 현 7(`backlog/todo/in_progress/in_review/done/blocked/cancelled`)→목표 10. net-new=`In QA`·`Blocked`(User/System 분리)·`Archived`(현 `hiddenAt`). Draft/Ready=리네임. ⚠️ 전이 무가드(`assertTransition` 타깃만 검증), 실 워크플로=execution-policy 스테이지 머신(직교). Blocked-by-User 레일=blocked-inbox attention로 부분 선구현(파생·미저장).
- **승인/DecisionRequest:** `approvals`(제네릭 type+payload·board 결정·agent wakeup·이슈 링크)=재사용 본거지. blocked-issue 승인만 기존(`request_board_approval`); release sign-off·capability 설치·plan-conflict=net-new type(설치 승인 게이트 현재 없음). reviewer/approver 스테이지는 `issue_execution_decisions`에 별도. ⚠️ 회사 승인은 board 전용 결정.
- **반영처:** `기본 기획서.md`「구현 그라운딩」.

## D17 — 구현 그라운딩 4: 컨텍스트/compaction · 스케줄러 · 업데이트 · 감사 · RBAC (코드 기준)
- **상태:** confirmed (2026-05-27, 코드베이스 조사)
- **컨텍스트:** donor=`/heartbeat-context` 번들+per-run `contextSnapshot`. ⚠️ **네이밍 함정**: 현 `session-compaction`=CLI 세션 로테이션(토큰윈도는 어댑터 위임), 스펙 4-plane/`ContextShard`/`CompactionRun`/on-demand는 net-new.
- **스케줄러/liveness(최강 재사용):** wakeup→`agent_wakeup_requests`→`startNextQueuedRunForAgent`(슬롯·우선순위·coalescing)→`executeRun` + 주기 reconciler(orphan/retry/stranded/watchdog). "에이전트 계속 행동" 구조적 충족. evolve `heartbeat.ts`+`index.ts`.
- **업데이트(부분):** 플러그인 `plugin-lifecycle.ts upgrade()`=capability-diff+`upgrade_pending` 승인. 스킬=핀+check만·즉시 적용. net-new=license diff·smoke·breaking-risk·scope+스킬 승인 retrofit.
- **감사(DB 영속):** `activity_log`/`secret_access_events`로 DB에 영속 기록. 엄격 불변(트리거/권한)은 선택적 후속 하드닝(V1 차단 아님; D18 재분류). 커버리지 opt-in(install/done 로깅 배선 필요). 메트릭/알림 없음(P4).
- **격리/RBAC:** 격리 강건(`companyId`+`assertCompanyAccess`+`deny_company_boundary`). RBAC 얇음=8 `PERMISSION_KEYS`+grant/scope/manager-chain(`authorization.ts`); advanced=P4. evolve `authorization.ts`.
- **반영처:** `기본 기획서.md`「구현 그라운딩」.

## D18 — 위임 승인 모드 (Delegated / Standing Approval) + 모순 재분류
- **상태:** confirmed (2026-05-27, 사용자 지시)
- **결정:** 승인(DecisionRequest)은 **두 모드**. 기본 `manual`=board(사용자) 직접 결정. 옵션 `delegated`=사용자가 범위별 **상시 위임(always approve)**을 켜면 그 범위 승인을 **최상위 기획자 Agent가 사용자 대신 자동 처리**(정책 확인 후 approve). 목적=저위험·반복 승인을 사람 루프에서 제거 → "사람의 시간을 핵심 의사결정에 집중".
- **가드레일:** 위임은 승인 type별·프로젝트별 범위 지정. 고위험(예산 하드스톱 초과·release sign-off 등)은 위임 제외/한도. 자동 승인은 audit에 "위임에 의함(delegated)" + 언제든 revoke. 위임 안 된 범위는 기존대로 board 결정.
- **코드 그라운딩:** `approvals` 결정 경로(현 `assertBoard`)에 "위임 정책 확인 → 위임 시 기획자 Agent 자동 승인" 분기 추가. 위임 설정은 회사/프로젝트 정책 저장. 이슈 단위 reviewer/approver 위임은 별개 `issue_execution_decisions`.
- **모순 재분류(사용자 확인):** #3 `activity_log` 불변 미강제=**모순 아님**(DB 영속됨; 엄격 불변은 선택적 후속). #5 approvals board-전용·#6 single-owner=**모순 아니라 net-new 베이스라인**(위임/pairing은 우리가 새로 도입). 진짜 함정은 #1(compaction 네이밍)·#2(charter 본문 롤백)·#4(trustLevel 이름충돌)뿐.
- **반영처:** `기본 기획서.md` 레퍼런스(승인 두 모드) + 「구현 그라운딩」 승인 bullet.

## D19 — 완료 후 Compound(정리·학습) 단계
- **상태:** confirmed (2026-05-27, 사용자 지시 — "명시 단계로 추가, 학습은 기존 문서/그래프에 흡수")
- **결정:** proof-gated Done 이후 `Archived` 전까지 **명시적 Compound 단계**를 운영 모델 1급으로 둔다. 기획자 Agent 주관: (a) `implemented/` 압축 반영+`TODO` 제거+지식 그래프 갱신, (b) 재사용 학습·예방 규칙·실패한 접근을 `implemented/` 스냅샷·그래프 노드·역할 산출물(`QA_PLAYBOOK`/`DESIGN_DASHBOARD`)에 **흡수**, (c) 건드린 범위의 debt·잠복 회귀·후속 슬라이스를 후속 이슈로 환원(없으면 근거 기록).
- **D11 정합(핵심):** **새 문서 종류 신설 금지** — issueflow의 `docs/solutions/`·prevention 노트 같은 별도 문서를 두지 않고, 학습/예방을 세 문서(SPEC·implemented·TODO)·역할 산출물·지식 그래프에만 녹인다.
- **근거:** 흩어진 조각(PlanSet 동기화·`QA_PLAYBOOK` 축적·그래프 갱신·compaction)을 완료 트리거 단계로 묶고, 빠져 있던 예방/학습/후속-스윕을 채움. issueflow `issue-compound`의 제품화.
- **단계화:** 문서 consolidation·후속 스윕·학습 흡수=코어(P1~P2); 그래프 갱신 부분=지식 그래프와 함께 P3.
- **반영처:** `기본 기획서.md`「범용 운영 모델」말미 Compound 문단 + 「에이전트 체계」기획자 role.

## D20 — 코드 그래프화 = Graphify 외부 MCP 사이드카(Option A), 벤더링 아님 (D12 정련)
- **상태:** proposed (2026-06-02, 딥리서치 `whpm95ucj` 기반 — **구현 착수 전 사용자 확정 필요**). D12의 "코드 그래프화는 Graphify식 도구 차용"을 실제 도구 조사로 정련.
- **배경:** 사용자 질문 — "Graphify를 in-process 라이브러리로 벤더링(Option B)하면 유지보수량이 줄지 않나?" → 실제 정체 조사 후 A vs B 결정.
- **조사 결과(18소스·25주장 적대검증, HIGH):** "Graphify" = **`safishamsi/graphify`** (PyPI `graphifyy`, CLI `graphify`). **MIT · Python 3.10+ · 활발히 유지보수**(최근 push 2026-05-31, ~122 릴리스, 단 pre-1.0 0.8.x churn). tree-sitter AST + NetworkX + Leiden로 코드그래프 생성. **경량 ✅** = 기본 출력 로컬 `graph.json`, "No Neo4j required, runs entirely locally"(Neo4j는 선택 extra) → **D12 "무거운 graph DB 미채택" 원칙 통과.** **MCP 네이티브 ✅** = `python -m graphify.serve`(`graphifyy[mcp]`) read 툴 query_graph/get_node/get_neighbors/shortest_path/PR-impact.
- **결정(권고): Option A** — Graphify를 **버전 핀된 외부 MCP 사이드카**로 연결, **코어/JS 프로세스에 벤더링하지 않음.**
- **근거:** ① **B는 물리적으로 불가** — 메인테이너 명시 "There is no npm, Node.js, or TypeScript package available." Python 전용이라 in-process JS 벤더 불가; 벤더링=핀된 Python 런타임/서브프로세스 떠안기=유지보수 *증가*. ② **A가 사용자의 본래 목표("재구현 안 함")를 그대로 충족** — Graphify가 그래핑을 소유, A는 MCP 경계로 Python을 프로세스 밖에 둠. ③ **기존 인프라 재사용** — WC-60~66 MCP 브리지 + capability 레지스트리 + `graph-enrichment` 시드가 정확히 이 경계용. `WORKCELL_GRAPH_MCP_COMMAND`(또는 신규 `code-graph` capability)를 `python -m graphify.serve`로 가리키면 **버전 bump→새 그래핑이 MCP 계약 너머로 유입 = OD(D13)와 대칭 "업데이트 혜택" 구조.**
- **잔여 작업(구현 시):** graph.json **빌드 스텝** + 그걸 KG의 **비어있는 `code` 노드**(GraphNodeKind enum에 정의됐으나 populator 없음)로 ingest(또는 Graphify query 툴 직접 소비). 미설정 시 graceful fallback(기존 패턴).
- **단서(정직):** pre-1.0 README 브랜치별 상이 → 특정 태그 핀+명령표면 재확인 필수. 비공식 TS 포트 `@mohammednagy/graphify-ts`=유일 in-process 경로지만 신뢰/유지보수 미검증(권장 안 함). 별 수(~57.5k)=미검증(활성도로만 판단). 이웃 도구(CodeGraphContext·techsavvyash/codegraph=Neo4j·vitali87/code-graph-rag=Memgraph) 다수가 무거운 DB 필수라 원칙 위배 — Graphify가 최경량.
- **영향:** 새 DB·새 인프라 0. **현재 KG 코드그래프화·시맨틱 메모리 전부 UNIMPLEMENTED(그린필드, 매몰비용 없음).** 구현은 **사용자 확정 + 실 Graphify(Python) 설치 + 실 repo** 필요 → 자율 green-proof 불가, **설계+백로그까지가 정직한 범위.**
- **구현 현황(2026-06-02):** **자율 hermetic 슬라이스 S1~S3 + HTTP 라우트 구현 완료(WC-107~110).** S1=`ingestCodeGraph` populator(중립 `CodeGraphImport` 계약, `code` 노드 충전)·S2=`code-graph` MCP capability 시드·S3=ephemeral 쿼리 overlay(`codeGraphNeighbors`)·라우트=ingest/overlay HTTP. Graphify 스키마 결합은 **S4(graph.json→CodeGraphImport 매퍼)에만 격리** → S1~S3은 Graphify 미설치로도 완전 검증(wc28 29/29·wc64 5/5·wc110 7/7·typecheck 0).
- **S4 매퍼 완료(2026-06-02, WC-121 `8c74768`):** 사용자 unblock("pip install 해도 돼") 후 **실 `graphifyy` 0.8.28 설치 + `graphify update --no-cluster` 실 export 추출**로 정확한 스키마 확정(NetworkX node-link, nodes `{id,label,file_type,source_file,source_location}` · links `{source,target,relation,…}`, relation=contains/imports_from/imports/calls). `services/graphify-import.ts` `mapGraphifyGraphToImport()` = 실 도구 대조 별칭 추출(pure·never-throws); `resolveCodeEdgeKind`에 `imports_from`→depends_on·`contains`→related 추가. proof: `graphify-import` 5/5(실 픽스처) + wc28 **30/30**(실 export→map→ingest end-to-end)·typecheck 0.
- **S4 운영 완료(2026-06-02, WC-122 `1ebf544`) — D20 end-to-end:** 운영 빌드 스텝까지 코드로 완성. ⓐ 서버 `POST .../code-graph/ingest-graphify`(raw graph.json→서버측 `mapGraphifyGraphToImport`→`ingestCodeGraph`, node-link 봉투 검증→400). ⓑ CLI `workcell code-graph from-repo --path <repo>`(`graphify update --no-cluster` 실행→graph.json POST; `--graph-json`/`--dry-run`/`--cluster` opt-in; 미설치 graceful). proof: wc110 10/10(+3 WC-122)·cli code-graph-producer 5/5·typecheck 0·**실 graphify 스모크**(graph.json이 기대 경로에 생성). **D20 S1~S4 전부 코드 완성** — 남은 건 graphify를 실 런타임에 설치하는 배포 선택뿐(OD와 동일 dormant→active, 연결부까지 코드 완비). S5(KG 뷰어 UI)=선택.
- **반영처:** D12 정련. 조사 출처 = 딥리서치 워크플로 `whpm95ucj`. (`github.com/safishamsi/graphify`, `…/serve.py`, `pypi.org/project/graphifyy`.)

## D21 — 페어 협업 워크스페이스 = run-path 라우팅(재설계), ad-hoc realize 금지
- **상태:** design (2026-06-02, 사용자 "pair 상용화 서비스 급 퀄리티" 지시 중 도출 — 코드 미착수, 보안민감 재설계라 신중 실행 필요).
- **배경:** 페어 턴이 *파일 편집* 협업을 하려면 실제 격리 워크스페이스(worktree)가 필요. WC-103은 **이미 realize된** execution workspace의 cwd를 *재사용*하지만, 이슈에 워크스페이스가 *없을 때 새로 생성*하는 경로가 없음(현재 페어 턴은 서버 process cwd로 떨어짐).
- **제약(핵심):** 워크스페이스 realize는 `environment-run-orchestrator.realizeForRun`이 소유하는데, 이건 **heartbeat run 생애주기에 묶여 있음** — Environment 해석 + EnvironmentLease 획득 + JWT 발급 + worktree realize + execution target 해석 + activity 기록이 *한 묶음*. 메모리 반복 경고(WC-99/103): 워크스페이스/세션/JWT는 한 묶음이라 **일부만 떼어내면(ad-hoc `realizeWorkspace` 직접 호출, lease/JWT/env 우회) 안전하지 않음** — 격리·정리·콜백 인증이 깨져 보안/안정성 구멍 = 상용화 품질 역행.
- **결정:** 페어 턴에 워크스페이스를 주려면 **페어 실행을 run-path로 라우팅**(페어 턴 = heartbeat run으로 실행하거나 run 오케스트레이션을 재사용)해서 realize가 **검증된 머신어리**로 일어나게 한다. ad-hoc realize 금지.
- **단계(제안):** ① 이슈에 워크스페이스가 없으면 run을 통해 ensure-workspace(lease+realize) → ② 페어 턴이 realized cwd 소비(WC-103 재사용이 이미 소비측 처리) → ③ 세션연속성·JWT는 run과 함께 따라옴. 비용/격리/정리는 run-path가 보장.
- **현재까지 parity(완료):** 모델선택 WC-97 · 기존-워크스페이스 grounding WC-103 · env-secret resolve WC-125 · 타임라인 투명성 WC-126 · 수렴까지 실행 WC-127 · 동시성 WC-128. text-collaboration 페어(제안/리뷰 라운드)는 위 parity로 이미 상용화 가능; *파일 편집* 페어가 D21을 요구.
- **구현 착수(2026-06-02, 사용자 "D21 재설계 진행" 승인):**
  - ⭐**핵심 de-risk 발견:** 워크스페이스 realize의 위험 가정(lease+JWT+worktree 한 묶음)이 **부분적으로 틀림.** `workspace-runtime.ts`의 **`realizeExecutionWorkspace(input)`가 export + lease/JWT와 decoupled** — LOCAL git_worktree는 `git worktree add`(+기존 reuse)만 하고 cwd 반환. heartbeat가 그 위에 lease/JWT/environment/execution-target을 두르는 것. **pair 턴=단일 adapter 턴+콜백 없음 → worktree만 필요, lease/JWT 불요.** 즉 realize 프리미티브 자체는 안전 재사용 가능(한 묶음은 heartbeat의 *래핑*이지 realize 자체가 아님).
  - **WC-130(`79fa50a`) — D21 Slice 1(realize seam):** `services/pair-workspace.ts` `realizePairWorktree({baseCwd,projectId,issue,agent})` = `realizeExecutionWorkspace`를 git_worktree 전략으로 래핑. **실 git 테스트**(throwaway 로컬 repo, DB 불요): repo root와 별개의 isolated worktree 생성·git이 linked worktree로 인식·재호출 시 idempotent reuse. pair-workspace 2/2·typecheck 0. realize 코어=증명됨.
  - **WC-131(`4d266d7`) — Slice 2(`ensurePairWorkspace`):** 이슈→projectId→`project_workspaces`(isPrimary).cwd 해석(깔끔, resolveWorkspaceForRun 안 거침) → reuse-or-realize → `execution_workspaces` 등록(WC-103 reuse 쿼리가 다음 라운드에 찾음·기존 close/cleanup 흐름이 teardown). 프로젝트/repo 없으면 graceful null(discussion-only). **embedded-pg+실git 테스트 4/4**(realize+register·reuse 무중복·null 2종).
  - **WC-132(`7f5fec8`) — Slice 3(executor 배선):** `BuildPairTurnExecutorOptions.ensureWorkspace` 주입 시 executor가 reuse-or-realize(WC-103는 reuse-only 유지), 실패→null(라운드는 계속). app.ts가 `WORKCELL_PAIR_LIVE_WORKSPACE`(live-LLM 위 별도 플래그)일 때만 `ensurePairWorkspace` 배선. **stub/기본 경로 byte-불변·lease/JWT 미터치.** wc33 +2·typecheck 0·**e2e 9/9**.
  - **WC-133(`21d86dc`) — Slice 4(cleanup): pair 완료시 worktree reap.** ensurePairWorkspace가 realize한 worktree를 `metadata.createdByPairGroupId`로 태깅(reused/일반 workspace는 untagged) → `closePairWorktrees(db,companyId,pairGroupId)`가 **태그된 것만** status closed+cleanupEligibleAt 마킹(실제 git worktree remove는 기존 cleanup 경로). 두 terminal 경로에 best-effort hook: `transitionStatus`(수동 abort/complete + orchestrator cap-abort) + `recordTurn` auto-stop(수렴/abort). reap 실패가 전이/턴기록을 막지 않음. pairGroupId를 executor ensureWorkspace 옵션+app 배선에 thread. **embedded-pg+실git: wc131 +2(태그된 것 reap·reused 미터치)·wc24/wc33 green·typecheck 0·e2e 9/9.**
  - **✅ 상태: D21 완료(Slice 1~4).** live 페어(WORKCELL_PAIR_LIVE_LLM+WORKCELL_PAIR_LIVE_WORKSPACE)가 격리 git worktree를 reuse-or-realize → 두 에이전트가 파일 편집 → pair 완료시 worktree reap. **heartbeat lease/JWT/session 일절 미터치·stub/기본 경로 byte-불변·전 슬라이스 테스트(실git+embedded-pg)·e2e 9/9.** "위험한 재설계"를 export 경계 확인+decoupled 프리미티브+플래그 게이트+작은 슬라이스로 critical infra 무회귀 안전 완수.

## D22 — Open Design 시안 = 앱/태스크의 Source of Truth (디자인이 구현을 끈다)
- **상태:** confirmed (2026-06-04, 사용자 지시 — "Open Design으로 만든 디자인 시안을 앱(혹은 어떤 project task)의 source of truth로 보고자 한다… 전체적인 시스템에서 이 철학을 잊지 않도록 해줘")
- **핵심 철학(시스템 전반 불변식):** Open Design으로 만든 **디자인 시안(artifact)을 앱(또는 임의의 project task)의 source of truth로 본다.** 디자인이 구현을 끌고 가며, 구현·QA는 시안에 **부합하는지로 측정**된다 — 역방향 금지(코드가 사실원이 아님). D13(통합 메커니즘=플러그인 capability pack + 사이드카 MCP 브리지)의 *목적*을 규정하는 상위 원칙.
- **두 발현(둘의 공통점 = 이 원칙):**
  - **(a) 기획-시안 생성 플로우 [WC-182]:** 기획 중 UI/화면 이슈에 디자이너 에이전트가 Open Design으로 **시안을 생성 → 이슈의 권위 있는(authoritative) 디자인 work product로 첨부** → 유저 디자인-리뷰 게이트 → 승인 후에만 개발 착수, 디벨로퍼·QA는 **승인된 시안 기준**으로 구현/검증(5-에이전트 워크플로의 디자이너 레그). 변경 요청은 디자이너 레그로 회귀.
  - **(b) 기존 프로젝트 디자인 복각 [WC-183]:** 기존 UI를 스캔 → **디자인시스템(토큰+컴포넌트) 추출**을 source-of-truth 아티팩트로 저장 → 그 시스템에서 기존 화면을 **복각(reproduce)**, 원본 스크린샷과 side-by-side 검증.
- **불변식(잊지 않기):** ① 이슈/프로젝트에 첨부된 디자인 아티팩트는 **canonical 디자인 스펙** — QA·리뷰는 빌드된 UI를 그것과 대조한다. ② 디자인시스템은 UI에서 사후 역설계되는 게 아니라 **시안에서 파생/시안이 UI를 구동**한다. ③ 시안은 버전·승인 상태를 가지며, source-of-truth 전환은 명시적(authoritative 플래그/타입드 링크)이다.
- **기존 인프라(재사용, D13 ⑤ 정합):** 뷰어=`plugin-open-design-dashboard`(`/design`), 라우트=`server/src/routes/design-artifacts.ts`(`GET /companies/:id/design-artifacts`), 아티팩트=`issue_work_products`(design/ui_preview/mockup/screenshot/figma_frame)+`assets`(새 코어 테이블 금지), 외부 생성=`WORKCELL_OPEN_DESIGN_MCP_COMMAND` 사이드카(미설정 시 graceful) — 단 생성은 디자이너 **에이전트**(self-contained HTML mockup 등)로도 가능(데몬 비필수). 리뷰 게이트=`request_confirmation`/executionPolicy user-stage(D18 위임 모드 호환). 역할=`uxdesigner`(visual-truth gate).
- **MISSING(=빌드 대상):** 현재 Open Design은 **뷰어만** 존재 — 생성기 아님. (a) 기획-시안 생성 + (b) 복각은 net-new. 슬라이스로 구현(WC-182 a / WC-183 b), 외부 데몬 미설정으로도 검증 가능한 경계 유지(D13·D20 dormant→active 패턴).
- **반영처:** D13 정련(목적=source-of-truth). 구현 이슈 WC-182/183. 이 결정은 두 기능의 **모든 레이어**(데이터·서비스·라우트·실행정책·UI·에이전트 프롬프트)가 지켜야 할 원칙 — 변경 시 이 불변식 우선.
- **구현 완료 (2026-06-04, 본 세션 — (a)①②③ + (b)1/2/3 전 슬라이스 develop 머지·화면검증):**
  - **WC-182 파운데이션:** D22 + source-of-truth 데이터층(`workProductService`: getAuthoritativeDesignForIssue/setAuthoritativeDesign/setDesignReviewState; reviewState=공유 IssueWorkProductReviewState 재사용) + 게이트 API(`POST /work-products/:id/design-review/submit|approve|request-changes`, board-decides) + 게이트 UI(`IssueDesignReviewPanel`).
  - **(a)① 생성/첨부:** `POST /issues/:id/design-artifacts`(`createDesignArtifactSchema`) + `@workcell/shared` 디자인타입(`DESIGN_WORK_PRODUCT_TYPES`) 중앙화 + 패널 "디자인 시안 첨부" 폼.
  - **(a)② 게이트→개발:** `deriveIssueDesignGate(workProducts)`를 heartbeat-context 번들에 주입(승인=시안 기준 빌드 디렉티브 / 미승인=developmentHold + HOLD 디렉티브) + 패널 hold-note. **실행정책 스테이지 머신·스케줄러 미터치(가산적)** — 하드 스케줄러 차단은 의도적 후속.
  - **(a)③ 디자이너 에이전트:** MCP `design_attach`(생성한 HTML→`data:text/html;charset=utf-8` 미리보기 / 또는 url)·`design_submit_for_review` + AGENTS.md "Design = source of truth" 섹션.
  - **(b)1 추출:** `services/design-system.ts` `extractDesignSystem(html)`(순수·정규식, 헤드리스/CSS파서 없음) → colors/typography/spacing/component + `POST /issues/:id/design-system`(저장: `metadata.kind=design_system`+tokens, isPrimary=false=참조).
  - **(b)2 스캔:** CLI `workcell design scan`(--html 파일 / --url 헤드리스 `@playwright/test` 동적임포트+graceful degrade).
  - **(b)3 복각:** `IssueDesignComparePanel`(추출 디자인시스템 vs 복각 화면 시안 side-by-side, design_system 아티팩트 없으면 미렌더) + AGENTS.md 복각 노트.
  - **검증:** 슬라이스별 타깃 그린 + 풀 UI 1163/1163 + (a)-arc 서버 통합 47/47 + **화면검증 2건**(게이트 미제출→보드검토→승인됨 / 복각 디자인시스템-대조 패널, charset=utf-8로 한국어 클린 렌더).
