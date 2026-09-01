#!/usr/bin/env bash
# 本地冒烟测试（不需要 API Key）：build → daemon → ping
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
$PNPM --filter @forge/cli... --filter @forge/daemon... run build

echo "==> init config"
node apps/cli/dist/cli.js init

DAEMON_PID=""
cleanup() {
  if [[ -n "${DAEMON_PID}" ]] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
    kill "${DAEMON_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> start daemon"
node apps/daemon/dist/main.js &
DAEMON_PID=$!
sleep 1

echo "==> ping"
node apps/cli/dist/cli.js ping

echo "==> core v2 capability probe"
node --input-type=module -e "
import { connectDaemon } from './packages/bus/dist/index.js';
import { loadConfig } from './packages/config/dist/index.js';
const cfg = loadConfig();
const client = await connectDaemon(cfg.daemon.socketPath);
try {
  const caps = await client.request('system.capabilities', {});
  if (caps?.protocolVersion !== 2) {
    console.warn('[smoke] daemon protocolVersion is not 2:', caps?.protocolVersion);
  } else {
    console.log('[smoke] protocolVersion=2 features=', Object.keys(caps.features ?? {}).join(','));
  }
} finally {
  client.close();
}
"

echo ""
echo "冒烟测试通过。接下来可配置 API Key 后执行："
echo "  node apps/cli/dist/cli.js config set model.apiKey <KEY>"
echo "  node apps/cli/dist/cli.js run \"用 echo 工具说 hello\" --cwd ."
