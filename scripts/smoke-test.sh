#!/usr/bin/env bash
# 本地冒烟测试（不需要 API Key）：build → daemon → ping → v2 run
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null; then
  echo "需要 Node.js 22+"
  exit 1
fi

PNPM="pnpm"
if ! command -v pnpm >/dev/null; then
  PNPM="npx pnpm@9"
fi

echo "==> install & build"
$PNPM install
$PNPM --filter @forge/cli... --filter @forge/daemon... --filter @forge/bus... --filter @forge/daemon-client... run build

echo "==> init config"
SMOKE_DATA="$(mktemp -d "${TMPDIR:-/tmp}/forge-smoke.XXXXXX")"
export FORGE_DATA_DIR="$SMOKE_DATA"
export FORGE_CONFIG_PATH="$SMOKE_DATA/config.json"
node apps/cli/dist/cli.js init

DAEMON_PID=""
cleanup() {
  if [[ -n "${DAEMON_PID}" ]] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
    kill "${DAEMON_PID}" 2>/dev/null || true
  fi
  if [[ -n "${SMOKE_DATA:-}" && -d "${SMOKE_DATA}" ]]; then
    rm -rf "${SMOKE_DATA}"
  fi
}
trap cleanup EXIT

echo "==> start daemon (FORGE_SMOKE=1)"
FORGE_SMOKE=1 node apps/daemon/dist/main.js &
DAEMON_PID=$!
sleep 1

echo "==> ping"
node apps/cli/dist/cli.js ping

echo "==> core v2 smoke run"
node scripts/core-v2/smoke-v2-run.mjs

echo ""
echo "冒烟测试通过。接下来可配置 API Key 后执行："
echo "  node apps/cli/dist/cli.js config set model.apiKey <KEY>"
echo "  node apps/cli/dist/cli.js run \"用 echo 工具说 hello\" --cwd ."
