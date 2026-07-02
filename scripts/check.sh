#!/usr/bin/env bash
# Workcell 로컬 proof 단일 진입점 (POSIX 미러). Windows는 scripts/check.ps1 우선.
# 기본 체크 = 전체 타입체크 (pnpm 모노레포).
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
echo "[Workcell] repo: $repo_root"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[Workcell] pnpm 미설치. 'npm i -g pnpm@9.15.4' 후 재시도."
  exit 1
fi

echo "[Workcell] typecheck (pnpm -r)..."
pnpm typecheck
echo "[Workcell] OK (typecheck 통과). 추가: 'pnpm build' / 'pnpm test:run' / 'pnpm test:e2e'."
