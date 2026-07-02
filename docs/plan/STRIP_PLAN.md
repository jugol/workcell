# STRIP_PLAN — Workcell (WC-1)

> Paperclip 포크 후 제거/정리 대상. **baseline 부팅 검증 후** 단계적 실행 + 각 단계 재검증.
> 원칙: 빌드/부팅을 깨지 않게 보수적으로. 어댑터/레지스트리 수술은 baseline 이후.

## 유지 (Keep)
- `packages/adapter-utils`, `packages/adapters/claude-local`, `packages/adapters/codex-local`
- `server`, `ui`, `cli`, `packages/db`, `packages/shared`, `packages/mcp-server`(MCP 브리지)
- `packages/plugins`(capability/plugin 계층 — 기획서 핵심)

## Strip 대상 + 리스크
### LOW (standalone — baseline 직후)
- `evals/` (promptfoo eval 하네스), `screenshots/`, `report/`
- (선택) `ui/storybook` 스토리 — dev 전용

### MEDIUM (레지스트리/워크스페이스 수술 필요) — ✅ 완료(2026-05-25, typecheck green)
- `packages/adapters/`: `acpx-local`, `cursor-cloud`, `cursor-local`, `gemini-local`, `grok-local`, `openclaw-gateway`, `opencode-local`, `pi-local` (8개)
  - 동반 정리: `pnpm-workspace.yaml`, adapter **registry** 등록 해제, UI의 adapter 선택지, `smoke:openclaw-*` 스크립트, 관련 테스트
  - 반드시 제거 후 `pnpm -r build` + 부팅 재검증

### TEXT / 브랜딩 (LOW, 신중) — WC-1c 1차 진행
- ✅ cli 배너 태그라인 reframe: "zero-human companies" → "Human-directed orchestration for AI agent teams" (`cli/src/utils/banner.ts`).
- ⏭️ 후속(gradual, 기획서대로 별도 단계): ASCII 아트(PAPERCLIP)·패키지명(`@workcell/*`)·전체 UI/docs 카피의 Paperclip→Workcell 리브랜드. `AGENTS.md`(런타임 영향) 카피 점검.
- ⏭️ 후속(QA): 35개 파일에 남은 죽은 어댑터 문자열 참조(대부분 테스트/상수) 정리 — kept 어댑터 테스트 재작성과 함께.

## 실행 순서
1. **baseline**: `pnpm install` → `pnpm dev`/`pnpm -r build` 부팅 확인 (strip 전 기준선) + `scripts/check.ps1` 연결
2. LOW 제거 → 재검증
3. MEDIUM 어댑터 strip(claude/codex만 유지) + registry/workspace 정리 → 재빌드/재부팅
4. 브랜딩/카피 정리
> 범위가 커지면 단계 2~4를 follow-up 이슈(WC-1b/WC-1c)로 분리.
