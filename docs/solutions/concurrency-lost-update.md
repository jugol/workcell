# 동시성 lost-update / read-modify-write

**관련 이슈:** WC-128, WC-154, WC-160, WC-161 (+ 미해결 chip: issues.executionState, env-runtime lease)
**클래스:** 락 없는 read→modify→write가 동시 실행 시 한쪽 갱신을 silent하게 덮어씀

## 증상
값을 SELECT → JS에서 수정 → write back 하는데, row 락(`SELECT … FOR UPDATE`)·atomic SQL·조건부(WHERE) 가드가 없으면 두 동시 호출이 같은 pre-image를 읽어 두 번째 write가 첫 번째를 clobber. 500이 안 나고 **상태만 조용히 틀어진다**(가장 음험).

## 처방 (상황별)
1. **jsonb/배열 부분 병합 → atomic `||`** (WC-161 권장 1순위):
   `SET col = coalesce(col,'{}'::jsonb) || ${patch}::jsonb` — `||`가 UPDATE의 row 락 하에서 **현재 값** 기준 평가되므로 동시 distinct-key 병합이 둘 다 살아남는다. 트랜잭션·마이그레이션 불필요. 단 정규화가 role 등에 의존하면(예: agents.permissions normalize) `||`로 부족 → 락 형태 필요.
2. **counter → atomic SQL**: `set({ n: sql\`n + 1\` })` (JS의 `row.n + 1` 금지).
3. **unique insert 경쟁 → `.onConflictDoNothing()` + 패자 re-select** (WC-128/129/143/154).
4. **다중 쓰기 시퀀스 → `db.transaction`** (WC-160: project + project_goals를 한 tx로; 무락 시 부분 실패가 고아/소실 유발). sibling `remove()`가 이미 tx면 그 패턴을 따르라.
5. **상태머신 read-modify-write → 락 또는 optimistic guard**: `WHERE status='pending' … RETURNING` 후 0행이면 conflict(thread-interactions 패턴) — 또는 tx + `for update`.

## 단일 인스턴스 전제
Workcell은 local-first 단일 서버 인스턴스(인스턴스별 embedded pg). in-process 직렬화(keyed async mutex)도 단일 인스턴스에선 유효하나, **DB 락/atomic이 더 견고**(다중 path·재시작 안전)하므로 코드베이스 관례는 DB 레벨이다.

## 안전한 swallow vs silent failure
이 코드베이스는 graceful-degradation(KG/MCP enrichment·OD overlay·audit/telemetry best-effort·reconciler 백킹)을 **의도적으로** 많이 쓴다 = 정상. silent-failure 버그는 **필수** 작업 실패를 삼키고 caller에 거짓 성공을 줄 때만. swallow-site는 (a) cleanup 후 rethrow (b) reconciler 백킹 (c) 비필수 audit 중 하나여야. (7번째 헌트 = 0건, 규율 양호.)

## 복잡-경로는 rush 금지 (chip 판단 기준)
fix가 (a) 핫패스 대규모 리팩터 (b) user-facing 동작 결정(예: 동시 충돌 시 seamless-merge vs 409) (c) provider 조정/마이그레이션이 필요한 lifecycle 변경이면 **inline rush 대신 tracked task(chip)**. 예) issues.executionState 동시 PATCH(370줄 핸들러 + 동작 결정), env-runtime sandbox-lease(provider 조정 + uniqueness 가드/마이그레이션). 깨끗한 단일-row CAS면 inline 안전, 그 이상이면 chip.

## ❌ 실패한 접근: executionState OCC pre-image 비교 (WC-163, 시도→revert)
issues.executionState 동시 PATCH lost-update를 **optimistic concurrency**로 고치려 시도: route가 `existing.executionState`를 pre-image로 svc.update에 넘기고, write를 `WHERE execution_state IS NOT DISTINCT FROM ${JSON.stringify(preImage)}::jsonb`로 가드 → 패자 0행 → 409. **단위/동시성 테스트(3/3)·route 스위트(82)·typecheck는 통과했으나 e2e signoff-policy 5건 red.**
- **근본 결함:** route의 `existing`은 `svc.getById`가 돌려준 **가공된 뷰**(직렬화/정규화)이지 **raw 저장 jsonb가 아니다**. `JSON.stringify(가공 뷰)` ≠ raw jsonb → 단일 순차 PATCH에서도 `IS NOT DISTINCT FROM`이 불일치 → **모든 executionState PATCH가 거짓 409**. 정상 stage-advance 흐름이 깨짐.
- **교훈 1:** OCC pre-image는 **반드시 raw 저장 값**이어야 한다(가공된 read-model 금지). 올바른 fix는 잠금-write 내부에서 raw 행을 재조회해 비교하거나(`for update` + tx), 전용 **version 컬럼**(증가 정수)로 CAS, 또는 seamless 락.
- **교훈 2:** **핫패스 동시성 fix는 e2e 머지게이트가 최종 심판** — 좁은 단위/동시성 테스트는 통과해도 실제 흐름(가공 read-model 사용)에서 깨진다. e2e가 잡았고 즉시 revert.

## ✅ 해결: executionState OCC = integer version 컬럼 (WC-163 v2, `dce81a1`)
v1 실패에서 **올바른 토큰 = raw 정수 version**임을 배워 재구현:
- **migration 0103 + 스키마:** `issues.execution_state_version` (integer, default 0).
- **svc.update:** patch가 executionState를 쓰고 caller가 읽은 version을 넘기면 `WHERE execution_state_version = :v`로 가드 + `SET version = v+1`. 패자 0행 → 409. **정수는 정확 비교 → 순차 PATCH 거짓 409 없음**(v1의 jsonb 직렬화 함정 제거).
- **route:** `existing.executionStateVersion` 읽어 thread. **issueListSelect**에 신규 정수 컬럼 추가(가공 read-model이 full-typed 유지 — 스키마 컬럼 추가의 type cascade는 이 한 곳뿐).
- **proof:** 동시성 테스트(패자 409·승자 intact·순차 OK) 3·route 81·workspace typecheck 0·**e2e 10/10**(v1을 veto한 그 게이트가 green).
- **scope:** route↔route(문서화된 시나리오) = WC-163. **route↔monitor = WC-164(`37b1c38`):** BEFORE UPDATE 트리거(migration 0104)가 execution_state 변경 시 version 자동 bump → 전 writer 커버(monitor·recovery·direct UPDATE). additive(route는 explicit bump 유지·트리거는 OLD+1 동일값 → double-bump 없음; WHEN 가드로 non-ES update 미bump=거짓409 없음). 동시성 4/4(version===1로 double-bump 부재)·e2e 10/10.
- **✅ 해결 — monitor write OCC (WC-166 `a630694`):** WC-164는 route가 monitor 변경을 **감지**(트리거 version bump→route 409)하나, monitor 자신의 executionState write(`heartbeat.ts` ~3033/2908/3072, `buildIssueMonitor{Triggered,Cleared}Patch`)는 OCC 미적용. monitor는 **merge**(claimed.executionState 읽어 monitor 서브상태만 set, route 필드 보존)라 full-clobber는 아니나, **claim→write 사이 좁은 창에서 route PATCH가 커밋되면** stale claimed 기준 merge로 그 변경을 덮어씀(매우 드묾). 완전차단=monitor write에 `WHERE execution_state_version=claimed.version` + 0행이면 fresh 재조회·재merge·재시도(executionState OCC와 scheduling 필드 분리 주의). **핫패스 변경 + e2e 미커버(monitor↔route 경쟁) = 신중한 전용 작업**(common route↔route/route-detect-monitor는 이미 커버). **WC-166 구현:** monitor의 3개 executionState write(triggerIssueMonitor + clearIssueMonitor 2경로)를 `applyIssueMonitorPatchWithOcc`(write 직전 fresh 재조회 → `WHERE execution_state_version` 가드 → 3회 재시도) 경유로 라우팅 → **모든 executionState writer(route+monitor) version-guarded**. monitor 디스패치 16/16(무회귀)·typecheck 0·e2e 10/10. fresh 재조회가 stale 창을 claim→write에서 read→write(μs)로 축소 + OCC가 잔여 경쟁 차단. **⇒ executionState lost-update 완전 종결(route↔route·route↔monitor·monitor↔route 전부).**
- **교훈 3:** 스키마 컬럼 추가(특히 NOT NULL)는 **curated `.select()` 맵 + full-row 헬퍼**에 type cascade 유발 → 신규 컬럼을 curated select에도 추가. 마이그레이션은 embedded-pg 테스트 1개로 즉시 검증 가능.
