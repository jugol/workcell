# DESIGN_DASHBOARD — Workcell

> UI UX Agent의 source of truth. 화면 추가/변경 시 항상 갱신. deprecated는 기본 목록에서 숨기고 Archive로.
> Phase 3에서 Open Design bridge 연결 시, preview는 iframe/artifact renderer로 즉시 보기 + 영역 코멘트.

## 현재 유효 화면 (Current)
| ID | 화면 | 상태 | 버전 | 승인 | linked issues | preview |
|----|------|------|------|------|----------------|---------|
| — | (아직 없음 — Phase 1 착수 후 추가) | — | — | — | — | — |

## 계획된 핵심 화면 (Planned — 미구현)
1. **Project Home** — 목표 경험·활성 이슈·blocked·최근 proof·비용 요약.
2. **Kanban Board** — 자연어 입력창 + 카드(owner role/single·pair/proof status/design impact/decision needed/usage burn) + `Blocked by User` 집중 레일.
3. **Issue Workspace** — classification/acceptance/non-goals/plan link + artifact 버전·diff·preview·annotation·pair turns·audit + proof-gated Done.
4. **Design Dashboard** — 본 문서의 제품화(현재/deprecated/버전비교/승인/preview/코멘트).
5. **Capabilities / Usage Center** — capability registry(visibility) + usage(Exact/Synced/Estimated 배지).

## Deprecated / Archive
- (없음)

## 디자인 원칙 (비협상)
- experience-first: 의도된 제품 화면, proof 대시보드를 기본 UI로 내세우지 않음.
- 첫 뷰포트 의미 · 시선 착지점 · 정보 계층/밀도 의도적.
- 카피는 자연스러운 한국어. 비아이콘 이미지는 래스터(JPG/PNG), SVG/CSS/canvas는 아이콘·컨트롤.
