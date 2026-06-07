# 자매 서비스 가드 동등성 (paired-service guard parity)

**관련 이슈:** WC-162
**클래스:** 짝을 이루는 서비스 중 하나만 입력 가드를 가져 다른 쪽에 잘못된-입력→500 갭

## 증상
거의 동일한 책임을 가진 두 서비스(예: `costService` ↔ `financeService`) 중 한쪽이 FK 존재 검증 같은 입력 가드를 갖고, 다른 쪽은 빠뜨림. 빠뜨린 쪽으로 잘못된(형식은 맞지만 존재하지 않는) FK uuid가 들어오면 zod는 통과 → insert에서 Postgres 23503 → **HTTP 500**(클린한 404/422가 아니라).

## 근본 원인
같은 패턴의 코드가 두 곳에 **복제**되면, 한쪽에 추가된 가드가 다른 쪽에 전파되지 않는다(guard drift). WC-162: `financeService.createEvent`는 `assertBelongsToCompany`로 agent/issue/project/goal/heartbeatRun **전부** 검증했으나 `costService.createEvent`는 agentId만 검증 → issue/project/goal/heartbeatRun FK가 무검증으로 insert 도달.

## 예방 규칙 (MUST)
1. **공유 검증기 추출**: 동일 검증 로직은 한 곳에 두고(export) 양쪽이 import. WC-162는 `assertBelongsToCompany`를 `finance.ts`에서 export해 `costs.ts`·`goals.ts`가 재사용.
2. **create/update가 FK 컬럼을 insert하면 존재 검증 필수**: 형식(zod `.uuid()`)만으로 부족 — 행 존재 + 테넌트(회사) 스코프를 확인해 **404/422로 매핑**. raw 23503이 500으로 새지 않게.
3. **자매 서비스 변경 시 양쪽 점검**: cost를 고치면 finance도(역도 마찬가지) 같은 가드가 있는지 확인.
4. **update 경로의 회사 스코프**: update는 companyId를 인자로 안 받을 수 있다 → 대상 행을 먼저 조회해 그 행의 companyId로 FK 검증을 스코프(WC-162 goalService.update).

## 일반화: request→500 robustness
잘못된 입력(형식은 valid)이 4xx 대신 unhandled 500을 내는 모든 경로가 이 클래스. 흔한 culprit:
- body/query FK uuid를 존재 미검증(23503).
- user-reachable unique insert를 `onConflict`/try-catch 없이(23505) → WC-128/129/143/154에서 `.onConflictDoNothing()`+re-select로 해결.
- query 숫자/날짜/URL 파싱 무가드(NaN/RangeError).
미들웨어에 전역 Postgres-코드→4xx 매핑이 없으므로 **서비스에서 사전 검증**이 정답.

## proof 패턴
embedded-pg 테스트: 존재하지 않는 FK로 create → `.rejects.toMatchObject({ status: 404 })` + 누수 행 0; 유효 ref는 성공. (costs-service.test.ts / goals-service.test.ts WC-162)
