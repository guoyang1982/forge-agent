#!/usr/bin/env bash
# Capture Forge Android startup crash logs.
set -euo pipefail
export JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

echo "==> devices"
adb start-server >/dev/null
adb devices -l
if ! adb devices | awk 'NR>1 && $2=="device"{found=1} END{exit found?0:1}'; then
  cat <<'EOF'
error: 没有可用设备。

请：
1) 手机打开「开发者选项 → USB 调试」
2) USB 连接电脑，弹窗点「允许」
3) 再跑本脚本
EOF
  exit 1
fi

APK="${1:-}"
if [[ -z "$APK" ]]; then
  APK="$(ls -t "$(cd "$(dirname "$0")/.." && pwd)"/release/Forge-*-android.apk 2>/dev/null | head -1 || true)"
fi
if [[ -n "$APK" && -f "$APK" ]]; then
  echo "==> uninstall old + install $APK"
  adb uninstall dev.forge.mobile >/dev/null 2>&1 || true
  adb install -r "$APK"
fi

OUT="$(cd "$(dirname "$0")/.." && pwd)/release/forge-android-crash.log"
rm -f "$OUT"
adb logcat -c
echo "==> launching app"
adb shell am force-stop dev.forge.mobile || true
adb shell am start -n dev.forge.mobile/.MainActivity
sleep 4
echo "==> collecting logcat → $OUT"
adb logcat -d -v time '*:E' ReactNative:V ReactNativeJS:V AndroidRuntime:E ActivityManager:I > "$OUT"
echo ""
echo "关键崩溃摘录："
rg -n "FATAL EXCEPTION|AndroidRuntime|ReactNativeJS|dev.forge.mobile|Expo|SoLoader|libc" "$OUT" | head -80 || true
echo ""
echo "完整日志: $OUT"
