# QA_PLAYBOOK — Workcell

> QA/QC Auditor가 축적하는 프로젝트별 품질 방법론. **proof bundle 없이는 Done 없음.**
> 시간이 지나며 패턴/시나리오를 여기 누적한다(빈 스켈레톤에서 시작).

## 완료(Done) 기준
1. acceptance criteria를 모두 충족하는 **사용자 가시 증거**가 있다.
2. proof는 real user path / user-facing surface 중심으로 묶인다(프루프 대시보드 자체가 목적이 아님).
3. green test라도 화면이 조악하거나 카피가 어색하면 **Done이 아니다**(qualitative 판정 포함).
4. ProofBundle(테스트 결과·스크린샷·golden·URL·QA verdict)이 이슈에 첨부됨.

## 증거 유형별 표준
- **웹 흐름:** Playwright 시나리오(핵심 user path). 셀렉터/네트워크/스크린샷 캡처.
- **시각 중요 화면:** golden/스냅샷 기준 + 디자인 의도(첫 뷰포트·시선·정보계층) 검토.
- **카피 품질:** 유창한 한국어 모국어 톤 점검(어색/번역투/진단문구 노출 금지).
- **백엔드/계약:** 단위·통합 테스트, 마이그레이션 적용 확인, audit 이벤트 생성 확인.
- **에이전트 실행:** Run 로그/transcript/비용 기록, pair인 경우 라운드 diff·stop reason.

## qualitative 감사 체크리스트 (요약)
- [ ] 첫 화면이 제품 약속을 보여주는가(진단 패널이 아니라)?
- [ ] 카피가 자연스러운가? 버튼/상태 메시지의 톤이 인간적인가?
- [ ] 정보 계층/밀도가 의도적인가?
- [ ] 비아이콘 이미지가 래스터(JPG/PNG)인가?
- [ ] 실패/blocked 상태가 사용자에게 명확히 보이는가?

## 로컬 proof 엔트리포인트
- `scripts/check.ps1` (Windows/PowerShell 우선). 스택 확정 후 lint/test/build를 이 스크립트가 호출하도록 채운다.

## 누적 패턴 (시간순 추가)
- (아직 없음 — 첫 이슈 QA 후 기록 시작)
