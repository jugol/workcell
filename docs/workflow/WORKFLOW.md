# WORKFLOW — Workcell (issueflow / Git Flow-lite)

> 이 저장소의 운영 규약. 실행 기준은 **로컬 명령/proof/계획 문서**. GitHub는 채택 시 audit 계층.

## 두 트랙 라우팅
- **Autonomous Cycle:** 계속/이어서/실패 처리/리뷰·플레이테스트 피드백 처리/다음 작업 선택. 내구 신호(current-state·plan gap·proof 실패·리뷰 발견)를 스캔해 이슈/웨이브 생성. 사용자가 모든 작업을 명명할 때까지 기다리지 않음.
- **Interactive Feature Intake:** 기능/제품 행동/UI 변경/모호한 개선 → 구체·저위험이 아니면 `issue-brainstorm` 후 `issue-raise`. 구체적 버그/피드백은 `issue-raise`.
- 기존 이슈 링크/본문 → `issue-intake`.

## 이슈 형태 / 품질
- 이슈는 메모가 아님: actor·target screen·state·data ownership·acceptance criteria·non-goals·proof surface·plan 관계(`aligned|extension|conflict|deviation`)·owner role·blocker.
- 기본은 **vertical slice**(한 사용자 가시 결과 + 필요한 domain/contract/UI/proof). 결과·owner·proof·의존·롤아웃이 독립일 때만 분할/웨이브.
- UI는 **experience-first**(의도된 제품 화면, proof 대시보드 아님). 카피는 자연스러운 한국어. 비아이콘 이미지는 래스터.

## 계획 진실성
- 기존 plan은 active truth. 새 이슈/웨이브는 plan과의 관계를 분류·인용.
- `extension`/`conflict`는 dispatch 전에 `DECISIONS.md`로 라우팅(구현이 제품 진실을 조용히 바꾸지 않게).
- plan 작업은 target user goal experience(user/situation·before·핵심 순간·after·가시 증거) 요구.

## 브랜치 생애주기 (Git Flow-lite)
- `main`: 릴리스. `develop`: 통합. `issue/*`: 단일 이슈 작업.
- 구체적 변경 전 브랜치 상태 확인. `issue/*`면 그 이슈만 진행, 아니면 merge/park 후 `develop`에서 새로 dispatch.
- 이슈는 `develop` 통합(또는 PR/merge 큐 핸드오프) + 체크아웃이 `develop`로 복귀해야 **완료**.
- 통합/PR 후: 이슈 노트·백로그/웨이브 보드·최신 proof 포인터·자동화 메모 갱신(완료 작업 재선택 방지).

## 로컬 체크
- 단일 진입점: `scripts/check.ps1`(Windows/PowerShell 우선). 스택 확정 후 lint/test/build를 호출하도록 채운다. CI는 동일 명령을 감싸기만.

## 서브에이전트 / 병렬 권한
- 기본 **명시 승인 필요**. 병렬 lane/worktree는 사용자/automation 프롬프트의 `issueflow parallel`(또는 이를 인용한 `CURRENT_STATE.md`) 있을 때만.
- lane이 독립이어도 권한 없으면 질문/일시정지; 겹치면 serialize + overlap 사유.
- worker dispatch 후 idle 금지: 읽기전용 스케줄러 작업(보드 갱신·비겹침 후보 스캔·다음 lane 준비) 지속. `wait`는 다음 메인 액션이 worker 출력에 막혔을 때만.

## 컨텍스트 거버넌스 / compaction
- active 파일은 얇게. full skill body/archive/과거 proof preload 금지 → index+pointer, on-demand fetch.
- `PLAN_ANCHOR.md`/`CURRENT_STATE.md` 약 150~250줄 초과 또는 완료 이슈 누적 시 compaction → `docs/history/`로 상세 이동, 인덱스만 남김.

## 자동화 일시정지 / 재개
- 사용자 입력·승인·크리덴셜·정책 선택이 필요하면 자동화를 **삭제하지 말고 PAUSED**. 기록: blocker·질문·활성작업·브랜치/워크트리·proof 포인터·재개 조건·다음 단계.

## 컴파운드 학습
- 재사용 학습/예방 규칙/실패 접근/후속 트리거/plan gap이 나오면 `issue-compound` → `docs/solutions/`에 노트 + `docs/solutions/INDEX.md` 갱신. 후속 이슈 생성 또는 no-follow-up 사유 기록.

## 루틴 매핑 (issueflow 스킬)
- 신규/채택: `repo-bootstrap` · 브레인스토밍: `issue-brainstorm` · 이슈화: `issue-raise` · 준비성: `issue-intake` · 분기/소유: `issue-dispatch` · 구현: `implement-web`/`implement-flutter` · QA: `qa-web-proof`/`qa-flutter-proof` · 머지: `merge-gate` · 릴리스: `release-gate` · 학습: `issue-compound`.
