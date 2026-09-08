# 本地冒烟测试（不需要 API Key）：build → daemon → ping → v2 run
# Usage: pwsh -NoProfile -File scripts/smoke-test.ps1
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "需要 Node.js 22+"
  exit 1
}

$Pnpm = "pnpm"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  $Pnpm = "npx pnpm@9"
}

Write-Host "==> install & build"
Invoke-Expression "$Pnpm install"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Expression "$Pnpm --filter @forge/cli... --filter @forge/daemon... --filter @forge/bus... --filter @forge/daemon-client... run build"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> init config"
$SmokeData = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $SmokeData | Out-Null
$env:FORGE_DATA_DIR = $SmokeData
$env:FORGE_CONFIG_PATH = Join-Path $SmokeData "config.json"
& node apps/cli/dist/cli.js init
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Daemon = $null
try {
  Write-Host "==> start daemon (FORGE_SMOKE=1)"
  $env:FORGE_SMOKE = "1"
  $Daemon = Start-Process `
    -FilePath "node" `
    -ArgumentList @("apps/daemon/dist/main.js") `
    -WorkingDirectory $Root `
    -PassThru `
    -WindowStyle Hidden

  Write-Host "==> ping"
  $ready = $false
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    & node apps/cli/dist/cli.js ping
    if ($LASTEXITCODE -eq 0) {
      $ready = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) {
    throw "Daemon did not become ready within 20s"
  }

  Write-Host "==> core v2 smoke run"
  & node scripts/core-v2/smoke-v2-run.mjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host ""
  Write-Host "冒烟测试通过。接下来可配置 API Key 后执行："
  Write-Host '  node apps/cli/dist/cli.js config set model.apiKey <KEY>'
  Write-Host '  node apps/cli/dist/cli.js run "用 echo 工具说 hello" --cwd .'
}
finally {
  if ($null -ne $Daemon -and -not $Daemon.HasExited) {
    Stop-Process -Id $Daemon.Id -Force -ErrorAction SilentlyContinue
  }
  if ($SmokeData -and (Test-Path $SmokeData)) {
    Remove-Item -Recurse -Force $SmokeData -ErrorAction SilentlyContinue
  }
}
