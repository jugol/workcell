# 표준 재구현의 silent 사양 이탈 (standard-compliance deviation)

**관련 이슈:** WC-167
**클래스:** 잘 알려진 표준(cron·semver·glob·HTTP·RFC 날짜 등)을 직접 재구현할 때, "파싱은 되지만 한 코너 케이스의 semantics가 표준과 다르게" 구현되어 사용자를 조용히 놀라게 하는 결함. 500도 안 나고 테스트도 통과하지만, **그 포맷을 아는 사용자의 기대와 어긋난다.**

## 증상
- 입력은 유효하게 받아들여지고 정상 동작하는 것처럼 보인다(에러 없음).
- 그러나 표준의 한 규칙을 구현이 빠뜨리거나 다르게 해석한다.
- 단위 테스트가 그 코너를 안 짚었으면 영원히 안 보인다(해당 입력을 아무도 안 써서가 아니라, 쓰는 사람이 표준 동작을 기대해서 더 위험).

## 사례 (WC-167)
cron `nextCronTick`/`matchesCronMinute`가 day-of-month와 day-of-week를 **논리 AND**로 결합. 표준 Vixie/POSIX `crontab(5)`는 **두 day 필드가 모두 restricted(둘 다 `*` 아님)이면 OR**, 아니면 AND(=단일 restricted 필드로 축약). 결과: `0 0 13 * 5`가 "금요일인 13일만"(AND)으로 동작 — 표준은 "13일 **또는** 임의 금요일"(OR). 코드 주석은 "both must match"로 **구현을 서술**했을 뿐, 제품 결정(테스트/DECISIONS 기록)이 아니었음.

## 처방
1. **표준 재구현은 "파싱 성공"이 아니라 "사양 전수 대조"로 검증.** 해당 표준의 man page/RFC/spec을 열어 **각 규칙**(특히 필드 간 상호작용·경계·특수값)을 체크리스트로 짚는다. cron의 DOM/DOW OR-rule처럼 "필드 둘이 만났을 때"의 규칙이 흔한 함정.
2. **확장 전 원본 토큰 정보를 보존.** `*`를 전체 값 리스트로 확장하면 "wildcard였는지"가 소실된다 → 표준 규칙(OR-when-both-restricted)이 그 정보를 요구하면 parse-time에 boolean 플래그로 남겨라(`daysOf{Month,Week}Restricted`).
3. **whole-class 수정.** 같은 표준을 해석하는 모든 사이트를 grep(이번엔 cron.ts `nextCronTick` + routines.ts `matchesCronMinute`)해 **공유 헬퍼**(`cronMatchesDay`) 하나로 통일 — 한 곳만 고치면 tz 경로/스케줄러 경로가 갈린다. 간접 소비자(plugin-job-scheduler→nextCronTick)는 자동 상속.
4. **회귀 가드는 "표준 vs 비표준이 갈리는" 입력으로.** 단순 happy-path가 아니라, **구 동작이라면 크게 틀릴** 입력을 골라라. 예: 2026 금-13일은 Feb/Mar/Nov 13 → 토요일 Mar 21 기점이면 OR=다음 금요일(7일내) vs 구 AND=Nov 13(~238일)로 극명히 갈림 → 그 gap이 회귀 신호.

## "deliberate 결정 vs 단순화" 판별
구현이 표준과 다를 때, 그것이 **의도된 제품 차별화**인지 **미구현 단순화**인지부터 가린다: (a) 그 동작을 단언하는 테스트, (b) DECISIONS/PLAN 기록, (c) 사용자 문서의 명시적 약속 — **셋 다 없으면 단순화**이고 표준 준수가 개선. 셋 중 하나라도 있으면 제품 결정이므로 사용자 확인 없이 바꾸지 말 것. (WC-167은 셋 다 없어 표준 준수로 수정.)
