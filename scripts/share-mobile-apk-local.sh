#!/usr/bin/env bash
# Open the built APK in Finder for WeChat / AirDrop / USB transfer.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="$(ls -t "$ROOT/release"/Forge-*-android.apk 2>/dev/null | head -1 || true)"

if [[ -z "$APK" || ! -f "$APK" ]]; then
  echo "==> no APK found, building..."
  bash "$ROOT/scripts/pack-mobile-android.sh"
  APK="$(ls -t "$ROOT/release"/Forge-*-android.apk | head -1)"
fi

open -R "$APK"
echo ""
echo "已在 Finder 中定位 APK："
echo "  $APK"
echo ""
echo "推荐传输方式（不依赖局域网/隧道）："
echo "  1) 微信：文件传输助手 → 发送此 APK 到手机"
echo "  2) 数据线：复制到 Android 下载目录后安装"
echo "  3) Mac 热点：系统设置 → 通用 → 共享 → 互联网共享，手机连 Mac 热点后执行 pnpm serve:mobile:android"
