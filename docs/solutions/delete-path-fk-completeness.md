# 삭제경로 FK 완전성 (delete-path FK completeness)

**관련 이슈:** WC-117, WC-118, WC-134, WC-135, WC-141, WC-158, WC-159, WC-171·WC-174(race 변종)
**클래스:** 엔터티 hard-delete 시 no-onDelete FK 자식이 미처리 → Postgres FK 위반(23503) → HTTP 500

## 증상
top-level 엔터티(agents/companies/issues/projects/goals)를 `remove()`로 hard-delete할 때, 그 엔터티 id를 참조하는 어떤 자식 테이블이 처리되지 않으면 마지막 `DELETE`가 FK 위반으로 500. 흔한 데이터(부모-자식 이슈 트리, agent 할당 루틴 등)에서 터진다.

## 근본 원인
Drizzle 스키마에서 FK가 `onDelete` 절 **없이** 선언되면 Postgres 기본 = NO ACTION/RESTRICT. 그 자식은 부모 `remove()` 트랜잭션 안에서 **명시적으로 삭제하거나 NULL-detach**해야만 안전하다. `onDelete: cascade`/`set null`이 있으면 DB가 자동 처리(미처리 OK).

## 예방 규칙 (MUST)
1. **새 FK를 top-level 엔터티에 추가할 때**: `onDelete`를 명시하거나, 그 엔터티의 `remove()`에 자식 처리(delete 또는 `.set({ fk: null })`)를 추가하라.
2. **자식이 top-level 엔터티면 DETACH**(null-detach, 레코드 보존), **콘텐츠/감사면 DELETE**, **billing이면 PRESERVE**(링크만 null — 회사 spend 이력 보존).
3. **불변식 동반 처리**: detach가 다른 불변식을 깨면 같이 고쳐라. 예) WC-158 — "active" 루틴은 default agent 필수(assertRoutineCanEnable)이므로 assigneeAgentId를 null detach할 때 status를 `paused`로 demote(같은 UPDATE의 CASE).
4. **회사 삭제 경로는 별도 주의**: `companyService.remove()`가 agents를 직접 `tx.delete(agents)`하면 `agentService.remove()`의 detach 로직(WC-158 루틴 demote 등)을 **우회**한다 → 회사 경로에도 동일 처리 필요(WC-159 routines purge).
5. **전수 감사**: bug class 발견 시 `packages/db/src/schema`에서 `.references(() => X.id` (onDelete 없는 것)를 grep → 각 부모 `remove()`와 교차대조. (서브에이전트 감사로 5개 엔터티 전수 = WC-159).

## proof 패턴
`server/src/__tests__/cleanup-removal-service.test.ts` (embedded-pg): 자식을 seed하고 `service.remove()`가 FK-500 없이 성공 + 자식이 detach/삭제됐는지 단언. fix 전엔 23503으로 red.

## ⚠️ race 변종: 명시 purge는 동시 writer에 안전하지 않다 (WC-171)
명시적 자식-purge가 **정적으로는** 맞아도, 그 자식 행을 **동시에 INSERT하는 live writer**가 있으면 race가 난다. WC-171: `agentService.remove()`가 런 삭제 전에 `heartbeat_run_events`를 purge하지만, **purge 후·런삭제 전**에 live 런 executor가 in-flight 런에 이벤트를 쓰면 참조행이 재유입 → 런삭제가 FK 위반 → **전체 agent 삭제 롤백**(실행 중 런을 가진 에이전트가 삭제 불가). 정적 테스트는 통과하나 실제 동시 실행에서만 터진다(WC-170 e2e가 에이전트를 런 도중 삭제하며 노출).
- **처방:** 활발히-써지는 ephemeral 자식 텔레메트리(run_events 등)는 **purge 대신 `onDelete: cascade`**. 부모 삭제와 원자적으로 제거되므로 purge↔삭제 사이 race 창이 없다. cascade는 "자식이 부모 소유"인 경우의 정확한 모델이기도 하다(run_events는 런 소유).
- **purge를 남길 때:** cross-parent 참조(예: 페어 카운터파트가 쓴, 다른 런의 이벤트 — `agent_id` FK)처럼 cascade 대상이 아닌 경우만. 그 경우도 동시 writer가 드물어야 안전.
- **판별:** 자식 테이블에 **백그라운드/동시 writer**(executor·스케줄러·텔레메트리 스트림)가 있나? 있으면 purge는 race-prone → cascade/SET NULL 우선.
- **cascade vs SET NULL (WC-174):** 자식이 **감사/이력(audit)**이면 cascade는 이력 삭제라 부적합 → **`onDelete: set null`**(dead pointer만 null, 행 보존). 보너스: **SET NULL은 blast-radius 0** — 부모 삭제가 "FK-block→pointer-null"로만 바뀌어 기존 통과 teardown을 절대 깨지 않는다(cascade는 trigger/flag 의존 경로서 teardown 대량 파괴 가능). 그래서 SET NULL은 타깃 검증만으로 안전.
- **트리거-보호 테이블의 SET NULL (WC-174):** append-only 등 mutation-차단 트리거가 걸린 테이블(activity_log)은 SET NULL이 **UPDATE**를 발생시켜 트리거가 막는다 → 트리거를 **그 FK-null-ing UPDATE만 정확히 허용**하도록 확장(해당 FK 컬럼을 null로 + 그 외 전 컬럼 불변일 때만; 그 외 UPDATE/DELETE는 계속 거부). wc29-immutability 테스트로 불변식 보존 확인 필수.

## 교훈
삭제경로 FK 완전성은 **새 자식 테이블이 추가될 때마다 재감사**가 필요하다(WC-141→158→159 연쇄가 증명). "fix the whole class"를 전수 FK 감사로 닫아라. 그리고 **동시 writer가 있는 자식은 정적-purge가 아니라 cascade**로 닫아라(WC-171).
