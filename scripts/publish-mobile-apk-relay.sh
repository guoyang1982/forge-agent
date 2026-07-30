#!/usr/bin/env bash
# Upload Forge Mobile APK to the Aliyun Relay and print an HTTPS download URL.
#
# Requires SSH access to the relay host (same as deploy/ssh-sync.sh).
#
# Usage:
#   RELAY_HOST=root@8.152.102.234 ./scripts/publish-mobile-apk-relay.sh
#   RELAY_HOST=root@8.152.102.234 RELAY_DOMAIN=relay.qingyi001.com ./scripts/publish-mobile-apk-relay.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="${RELAY_REMOTE_DIR:-/opt/forge-relay}"
RELAY_HOST="${RELAY_HOST:-}"
RELAY_DOMAIN="${RELAY_DOMAIN:-relay.qingyi001.com}"
SSH_KEY="${RELAY_SSH_KEY:-${SSH_KEY:-}}"

if [[ -z "$RELAY_HOST" ]]; then
  echo "error: set RELAY_HOST, e.g. RELAY_HOST=root@8.152.102.234" >&2
  exit 1
fi

APK="$(ls -t "$ROOT/release"/Forge-*-android.apk 2>/dev/null | head -1 || true)"
if [[ -z "$APK" || ! -f "$APK" ]]; then
  echo "==> no APK in release/, building..."
  bash "$ROOT/scripts/pack-mobile-android.sh"
  APK="$(ls -t "$ROOT/release"/Forge-*-android.apk | head -1)"
fi

APK_NAME="$(basename "$APK")"
SSH_ARGS=(-o StrictHostKeyChecking=accept-new)
if [[ -n "$SSH_KEY" ]]; then
  SSH_ARGS+=(-i "$SSH_KEY")
fi

echo "==> upload $APK"
ssh "${SSH_ARGS[@]}" "$RELAY_HOST" "mkdir -p $(printf '%q' "$REMOTE_DIR/deploy/mobile-dist")"
scp "${SSH_ARGS[@]}" "$APK" "${RELAY_HOST}:${REMOTE_DIR}/deploy/mobile-dist/${APK_NAME}"

echo "==> reload caddy (if compose stack is running)"
ssh "${SSH_ARGS[@]}" "$RELAY_HOST" bash -s <<REMOTE
set -euo pipefail
cd $(printf '%q' "$REMOTE_DIR/deploy")
if docker compose ps --status running caddy >/dev/null 2>&1; then
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile || docker compose restart caddy
else
  echo "warning: caddy not running; deploy updated Caddyfile/mobile-dist then: docker compose up -d"
fi
REMOTE

DOWNLOAD_URL="https://${RELAY_DOMAIN}/mobile/${APK_NAME}"
echo ""
echo "Forge Mobile HTTPS 下载链接："
echo "  $DOWNLOAD_URL"
echo ""
echo "手机浏览器直接打开即可下载（无需同 Wi‑Fi）。"
echo "若 404，请先在服务器同步最新 deploy/Caddyfile 与 docker-compose.yml 后重启 caddy。"
