#!/usr/bin/env bash
# Publish Forge Mobile via Expo EAS (cloud build + QR install page on expo.dev).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE_DIR="$ROOT/apps/mobile"

cd "$MOBILE_DIR"

if ! pnpm exec eas whoami >/dev/null 2>&1; then
  echo "请先登录 Expo 账号（免费）："
  echo "  cd apps/mobile && pnpm exec eas login"
  exit 1
fi

if ! rg -q '"projectId"' app.json 2>/dev/null; then
  echo "首次发布需要关联 Expo 项目："
  echo "  cd apps/mobile && pnpm exec eas init"
  echo ""
  echo "按提示选择 Create a project，会在 app.json 写入 projectId。"
  exit 1
fi

echo "==> EAS cloud build (Android APK, internal distribution)"
pnpm exec eas build --platform android --profile preview "$@"

echo ""
echo "构建完成后："
echo "  1) 打开终端输出的 expo.dev 构建链接"
echo "  2) 页面会显示 Android 安装二维码，手机扫码即可下载 APK"
echo "  3) 或执行: cd apps/mobile && pnpm exec eas build:list"
