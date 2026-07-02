# "Skip the human" 기능은 모든 휴먼-게이트 메커니즘을 커버해야 한다

**관련 이슈:** WC-168(executionPolicy user-stage skip), WC-176(request_confirmation auto-accept)
**클래스:** "유저 참여를 건너뛴다"는 기능을 **한 가지** 게이트 메커니즘에만 구현 → 테스트는 통과하나 실제 워크플로가 **다른** 게이트 메커니즘을 써서 여전히 사람에 파킹.

## 증상
autonomous/skip mode를 만들고 단위·e2e 테스트가 전부 green인데, **실제 에이전트를 돌려보면** 워크플로가 여전히 유저 입력을 기다리며 멈춘다. e2e가 쓴 게이트(executionPolicy stage)와 실 에이전트가 쓰는 게이트(request_confirmation thread-interaction)가 **다른 메커니즘**이었기 때문.

## 근본 원인
Workcell에는 "사람이 검토/승인"을 표현하는 경로가 **둘 이상**:
1. **executionPolicy stages** — `participants:[{type:"user"}]` 리뷰/승인 스테이지(이슈 PATCH 전이 엔진). WC-168 skip이 커버.
2. **request_confirmation thread-interaction** — 에이전트가 산출물(plan 문서 등)에 대해 유저 확인을 요청(POST /issues/:id/interactions). **실 LLM 에이전트가 기획 검토에 실제로 쓰는 경로.** WC-168이 미커버 → WC-176으로 추가.

(추가 휴먼 게이트: hire board-approval[WC-168 커버], 일반 approvals[budget override 등 — 의도적 미skip=안전게이트], Open Design UI-OK[코드 미강제].)

## 예방 규칙 (MUST)
1. **"사람이 개입하는 지점"을 코드 전수로 열거하라.** grep: `type:"user"`/`assigneeUserId`(executionPolicy), `request_confirmation`/`acceptInteraction`(thread-interaction), `requireBoardApproval`/`approvals`(승인), 그 외 "pending user"·"awaiting"·"confirm" 패턴. 하나만 보고 "다 했다" 금지.
2. **각 게이트마다 skip 시맨틱을 정의:** user-참여 게이트는 auto-resolve(시스템이 대신 승인)+워크플로 continuation(에이전트 재wake), agent 품질 게이트(QA/compound)는 **유지**, 금전 안전게이트(budget)는 **유지**.
3. **auto-resolve는 continuation까지.** 게이트만 resolve하고 continuation(에이전트 재wake)을 빠뜨리면 워크플로가 stall. 정상 accept 라우트의 continuation 처리(예: queueResolvedInteractionContinuationWakeup)를 미러하라.

## ⭐ 핵심 교훈: stub e2e green ≠ 실 워크플로 동작
- skip mode를 **executionPolicy stage** 기반 e2e로만 검증 → 3/3 green. 하지만 **실 claude_local 에이전트를 구동**하니 에이전트가 **request_confirmation**을 써서 갭 노출(NOT-1: pending 고착). 
- **stub adapter e2e는 "내가 만든 게이트"를 검증할 뿐, 실 에이전트가 실제로 쓰는 게이트를 검증하지 않는다.** 로컬 CLI(`claude`/`codex`)가 있으면 **claude_local 어댑터로 실 에이전트 1런**을 격리 throwaway 인스턴스(별도 home/port, throwaway cwd, 커밋된 트리)서 돌려 **실 워크플로가 실제로 무엇을 하는지** 관찰하라. 비용($1~2/런)은 갭 1건 = 충분히 가치.
- 검증: autonomous OFF vs ON 대조(OFF=pending 고착·ON=accepted→done 무인 도달)가 fix의 결정적 증거.

## proof 패턴
- 단위/route: instance-settings 직접-import 목 + getExperimental→autonomousMode 토글, request_confirmation 생성 시 acceptInteraction 호출 단언(ON)·미호출(OFF) — `issue-thread-interaction-routes.test.ts`.
- 라이브: 격리 인스턴스 + claude_local 에이전트 실런 → OFF=pending·ON=done 대조.
