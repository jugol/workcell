#!/usr/bin/env pwsh
# Workcell 로컬 proof 단일 진입점 (Windows/PowerShell 우선).
# 포크 베이스(Workcell)는 pnpm 모노레포. 기본 체크 = 전체 타입체크.
# CI는 이 스크립트를 감싸기만 한다.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -Path $repoRoot
Write-Host "[Workcell] repo: $repoRoot"

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "[Workcell] pnpm 미설치. 'npm i -g pnpm@9.15.4' 후 재시도." -ForegroundColor Red
    exit 1
}

Write-Host "[Workcell] typecheck (pnpm -r)..."
pnpm typecheck
if ($LASTEXITCODE -ne 0) {
    Write-Host "[Workcell] typecheck FAILED" -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host "[Workcell] OK (typecheck 통과)." -ForegroundColor Green
Write-Host "[Workcell] 추가: 빌드 'pnpm build' / 단위 'pnpm test:run' / e2e 'pnpm test:e2e'."
exit 0
