# PLAN_ANCHOR — Workcell

> 얇은 앵커. 현재 macro 방향과 비협상 목표만 담는다. 상세는 `docs/plan/PLAN.md`, 원본은 `기본 기획서.md`.
> 길이 가이드: 약 150~250줄 이내 유지. 완료 이슈/오래된 결정은 `docs/history/`로 이동.

## 핵심 제품 약속 (Core Product Promise)

**사용자가 큰 방향을 정하고, AI 에이전트들이 "회사처럼" 실행하는 프로젝트 운영 플랫폼.**
운영은 회사처럼(조직/예산/거버넌스/감사), 실행은 이슈처럼(plan→goal experience→issue→proof), 판단은 인간이(승인·방향·정책 소유). 무인 회사(zero-human)가 아니라 **사람 중심 실행 보조**.

## 타깃 사용자 목표 경험 (Target User Goal Experience)

- **사용자/상황:** 여러 프로젝트(소프트웨어·콘텐츠·디자인·운영)를 직접 다 실행하기 버거운 1인 창업자/소규모 팀의 board(창업자).
- **이전 상태:** 채팅형 AI에 매번 맥락을 다시 설명, 산출물·진행상황·비용·디자인이 흩어져 있고 "끝났다"의 기준이 모호.
- **핵심 제품 순간:** 칸반 보드 상단에 자연어로 "이 기능/화면/흐름을 ~해줘"라고 적으면 → 기획자 Agent가 즉시 acceptance criteria·non-goals·proof surface를 갖춘 **이슈 초안**을 만들고, 적절한 역할의 에이전트(또는 pair)가 이슈를 물고 가 **산출물 + 증거(proof)**를 남긴다. 사용자는 **승인과 방향만** 결정한다.
- **이후 상태:** 사용자는 "방향 설정 + 승인 + blocked 결정"만으로 회사처럼 굴러가는 프로젝트를 운영한다.
- **사용자 가시 증거:** 이슈가 proof bundle과 함께 Done 처리되고, 화면/산출물이 Design Dashboard에서 미리보기로 보이며, 비용/잔여량이 Usage Center에 정확도 배지와 함께 정직하게 표시된다.

## 비협상 UX / 아트 / 카피 기준

- 화면은 **의도된 제품 경험**이어야 한다. proof 대시보드/진단 패널을 기본 UI로 내세우지 않는다(운영 도구 자체가 목적인 화면 제외).
- 첫 뷰포트 의미, 시선 착지점, 정보 계층/밀도가 의도적이어야 한다.
- 카피는 **유창한 모국어 화자**가 쓴 것처럼 자연스러워야 한다(기본 한국어). 진단/내부 문구는 숨기거나 test-only.
- 비아이콘 제품/씬 이미지는 생성/캡처된 래스터(JPG/PNG) 사용. SVG/CSS/canvas는 아이콘·컨트롤에 한정.

## 1차 핵심 경험 (Phase 1 primary action)

칸반 보드의 **"자연어 → 이슈"** 변환과 **Issue Workspace**에서 single-owner 실행 + proof bundle로 Done까지. blocked decision의 가시성 확보.

## MVP 경계 (요약)

- 신규/기존 프로젝트 bootstrap, 자연어 이슈 생성, WorkOwner=`single|pair`(pair 최대 10라운드·stop reason·라운드 diff·비용), UI UX Agent의 Open Design 기반 preview + Design Dashboard(current/deprecated 구분), Developer Agent 이슈 단위 vertical slice(+독립 lane 병렬 worktree), QA/QC Auditor의 proof-없이-Done-불가, Capability Registry(scope/visibility/user-triggered update), Usage Center(Exact/Synced/Estimated 배지), 컨텍스트 compaction/on-demand 로딩, 전 mutating action audit.
- 상세 수용 기준: `docs/plan/PLAN.md` §MVP 수용 기준.

## 안티 목표 (Anti-goals)

- 무인(zero-human) 자율 회사를 만들지 않는다 — 사람이 방향·승인의 소유자.
- 한 이슈에 top-level owner를 둘 이상 두지 않는다(pair는 owner 내부 실행 모드).
- 무한 토론형 멀티에이전트(비용/라운드 상한 없는)로 가지 않는다.
- 운영 컨텍스트를 무한 메모장처럼 키우지 않는다(앵커/현재상태는 얇게).
- 미검토(unreviewed) capability를 auto-invoke 하지 않는다.

## 서브에이전트 권한 정책 (요약)

- 기본: **명시 승인 필요**. 자동화/병렬 lane은 사용자/automation 프롬프트의 `issueflow parallel` 또는 이를 인용한 current-state 핸드오프가 있을 때만.
- 상세: `docs/workflow/WORKFLOW.md`.

## 현재 상태 포인터

- 진행: `CURRENT_STATE.md`
- 백로그/웨이브: `docs/BACKLOG_BOARD.md`
- 결정 로그: `docs/plan/DECISIONS.md`
