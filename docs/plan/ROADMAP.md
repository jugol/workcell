# Workcell — ROADMAP

> 4단계. 각 단계는 "Paperclip control plane 활용 → issueflow 운영 규율 → Open Design/외부 능력 확장" 순서로 리스크를 낮춘다.
> 단계별 산출은 MVP 수용 기준(`PLAN.md` §9)과 매핑한다. 단계 안에서 vertical slice 우선.

## Phase 1 — 실행 코어 (single-owner)
**범위:** Project bootstrap · Planner Agent · Kanban Board(자연어→이슈) · Issue Workspace · single-owner 실행 · ProofBundle · 기본 Usage Center.
**1차 vertical slice 후보:** "보드에 자연어 입력 → Planner가 이슈 draft 생성 → single Developer가 실행 → proof와 함께 Done." (실제 사용자 경험을 첫 화면부터 보여줄 것)
**충족 기준:** #1(신규 bootstrap), #2, #6(proof-gated done 일부), #8(기본), #10(audit 기초).

**구현 진행(2026-05-29 기준):**
- ✅ **자연어→Planner 이슈 초안** (WC-2 — `POST /issues/draft-from-prompt`).
- ✅ **Proof-gated Done** 듀얼 게이트(early at PATCH + late at svc.update, WC-3/7); planning/recovery originKind 면제.
- ✅ **실행 루프 proof bundle 지시** (WC-4 — task prompt에 directive 주입).
- ✅ **기본 QA-리뷰 사인오프 정책** 자동 주입 — create(WC-5) + assignment PATCH(WC-6).
- ✅ **시각 칩 트리오** Kanban + IssuesList에 role/proof/usage (WC-8~11, positive-only tri-state).
- ✅ **Compound 단계 첫 사이클** — Done 시 compound-checklist 자동 생성(WC-12) → `## 5. Follow-up issues` 불릿을 실제 backlog 이슈로 환원(WC-13, `POST .../compound-followups/process`) → IssueDocumentsSection 메뉴에 "Process follow-ups" 액션 노출(WC-14). e2e로 chain 검증(WC-15).
- 🔲 **남은 갭:** Planner/QA 에이전트가 compound-checklist 본문을 LLM으로 자동 fill, Usage Center 풀버전, 추가 capability 작업.

## Phase 2 — 협업/품질 (pair + QA gate + design)
**범위:** PairGroup(라운드 diff·stop policy·비용) · Blocked decision 레일 · QA/QC gate · Design Dashboard 기본형(plugin `page` 슬롯 + 샌드박스 iframe 프리뷰, D13).
**충족 기준:** #3(pair), #4(design dashboard 기본), #6(완전한 proof-gated done).

## Phase 3 — 확장 (Open Design / capability / context)
**범위:** Open Design bridge(플러그인 capability pack + outbound MCP 브리지 — D13, 지식그래프 MCP와 공유) · Capability Registry · scope assignment · user-triggered update · context compaction · visibility control · **프로젝트 지식 그래프 PoC**(코드+기획 단일 경량 인덱스, 이슈 DB 참조·`plugin-llm-wiki` 흡수, Postgres+AGE/pgvector — D12).
**충족 기준:** #4(Open Design preview), #5(병렬 worktree dispatch), #7(capability), #9(compaction/on-demand).

## Phase 4 — Enterprise hardening
**범위:** adapter smoke tests · provider failure classification · alerting · backup/export · metrics · advanced RBAC.
**충족 기준:** #8(정확도/sync 강화), #10(전 영역 audit/observability) + 운영 견고화.

## 시퀀싱 원칙
- 코어 제품 약속(자연어→이슈→실행→증거)이 없는 동안 내부 proof 계층에 여러 wave를 쓰지 않는다.
- support/contract-first 작업은 그것이 가능케 하는 downstream core slice를 명시.
- plan extension/conflict는 dispatch 전에 plan governance(`DECISIONS.md`)로 라우팅.
