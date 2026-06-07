# Append-only table teardown: TRUNCATE, never DELETE

**관련 이슈:** WC-29 (trigger), WC-50 (first fix), WC-136 (class fix)
**클래스:** 테스트 teardown이 trigger-보호 append-only 테이블을 DELETE → 광범위 잠복 red

## 증상 (Symptom)

테스트 `afterEach`/`beforeEach`에서 `await db.delete(activityLog)` 실행 시:

```
PostgresError: activity_log is append-only — DELETE on row id=… rejected
  (PL/pgSQL function activity_log_block_mutation())
```

단, **해당 테스트가 activity_log 행을 seed 했을 때만** 실패한다 (빈 테이블 DELETE는
per-row trigger를 발화시키지 않으므로 통과 → 잠복성이 높음).

## 근본 원인 (Root cause)

- WC-29 (`0096_activity_log_immutable.sql`)가 activity_log에 `BEFORE DELETE/UPDATE FOR EACH ROW`
  trigger(`activity_log_block_mutation`)를 추가 → row-level DELETE를 영구 차단.
- 22개 테스트 스위트가 여전히 `db.delete(activityLog)`로 teardown.
- **per-slice merge gate는 각 슬라이스 자기 스위트만 실행** → WC-29 이후 이 22개 스위트는
  한 번도 재실행되지 않아 **56개 테스트 / 21개 스위트가 WC-29 시점부터 잠복 red**.
- 즉 "per-slice green ≠ integration green". 전역 DB 변경(trigger)이 그 변경과 무관한
  스위트들의 teardown을 조용히 깨뜨림.

## 해법 (Fix)

`DELETE` 대신 `TRUNCATE`. TRUNCATE는 DDL이라 row-level trigger를 우회한다:

```ts
// ❌ trigger가 거부
await db.delete(activityLog);
// ✅ DDL — row trigger 우회, CASCADE로 FK 의존 정리, identity 리셋
await db.execute("truncate table activity_log restart identity cascade" as any);
```

`wc29-activity-log-immutability.test.ts`는 의도적으로 `expect(db.delete(activityLog)).rejects`로
trigger를 검증하므로 **건드리지 않는다** (immutability 보장 자체는 유지).

## 예방 규칙 (Prevention)

1. **append-only/trigger-보호 테이블은 teardown에서 절대 DELETE 금지 → TRUNCATE 사용.**
   현재 해당: `activity_log` (유일한 immutability trigger 테이블, 0096).
2. **전역 DB 제약/trigger를 추가할 때**, 모든 테스트 teardown에서 그 테이블의 DELETE를
   grep으로 전수 점검: `rg "delete\(<table>\)" server/src/__tests__`.
3. **per-slice 타깃 스위트만 믿지 말 것.** 주기적으로 cohesive cert
   (`node scripts/run-vitest-stable.mjs`, 또는 영향 스위트 묶음 실행)로 통합 green을 확인.
   전역 변경(스키마/trigger/FK/공유 헬퍼) 직후엔 반드시.

## 탐지 방법 (Detection)

여러 스위트를 한 번에 돌리는 cohesive vitest 실행이 per-slice 실행이 숨기는 잠복 red를
드러낸다. DB-heavy 스위트는 embedded-postgres 자원 경합을 피하려 **직렬 실행**해야 한다
(`server/vitest.config.ts`는 `maxForks:1`; `run-vitest-stable.mjs`의 serialized 모드가
route/authz/heavy-DB 스위트를 1개씩 isolate 실행). 23개를 한 invocation에 몰아넣으면
0 test-fail + 다수 skip 형태의 **자원 경합 위양성**이 생기므로 ~12개 배치로 나눠 검증.
