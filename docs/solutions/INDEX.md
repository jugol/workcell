# Solutions Index — Workcell

> 재사용 가능한 해법/예방 규칙/실패한 접근/후속 트리거 노트의 색인. 본문은 `docs/solutions/<slug>.md`, 여기엔 한 줄 요약만.
> 작성 트리거: `issue-compound` (재사용 학습·예방 규칙·실패 접근·plan gap 발견 시).

| slug | 요약 | 관련 이슈 |
|------|------|-----------|
| [activity-log-teardown-truncate](activity-log-teardown-truncate.md) | append-only/trigger-보호 테이블은 teardown에서 DELETE 금지 → TRUNCATE; 전역 DB 변경 후엔 cohesive cert 필수 (per-slice green ≠ integration green) | WC-29, WC-50, WC-136 |
| [delete-path-fk-completeness](delete-path-fk-completeness.md) | top-level 엔터티 hard-delete 시 no-onDelete FK 자식을 remove()에서 delete/detach 안 하면 23503→500; 새 자식 테이블마다 전수 FK 감사 + 불변식 동반 처리(active 루틴 demote) | WC-117/118/134/135/141/158/159 |
| [paired-service-guard-parity](paired-service-guard-parity.md) | 자매 서비스(cost↔finance) 가드 drift → 한쪽만 FK 검증해 잘못된-입력 23503→500; 공유 검증기 export·재사용, create/update의 FK는 존재+테넌트 검증해 4xx로 | WC-162 |
| [concurrency-lost-update](concurrency-lost-update.md) | 락 없는 read-modify-write가 동시 clobber → atomic jsonb `||`/SQL counter/onConflict/tx; graceful-degradation은 정상(silent-failure 아님); 복잡-경로(executionState·lease)는 rush 금지 chip | WC-128/154/160/161 |
| [standard-compliance-deviation](standard-compliance-deviation.md) | 표준(cron·semver·glob 등) 재구현 시 "파싱 성공"≠"사양 준수" — 코너 semantics(예: cron DOM/DOW OR-rule) silent 이탈은 테스트로 안 잡힘; 확장 전 원본 토큰 보존·공유 헬퍼·표준-갈림 입력으로 회귀 가드; deliberate(테스트/문서) 없으면 단순화로 보고 표준 준수 | WC-167 |
| [skip-mode-gate-coverage](skip-mode-gate-coverage.md) | "유저 참여 skip" 기능은 휴먼-게이트 메커니즘을 **전수** 커버해야(executionPolicy user-stage + request_confirmation 둘 다); stub e2e green≠실 워크플로 — 로컬 CLI 있으면 claude_local 실 에이전트 1런(격리 throwaway)으로 갭 노출; auto-resolve는 continuation(에이전트 재wake)까지 | WC-168, WC-176 |
