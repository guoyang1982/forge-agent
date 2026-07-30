#!/usr/bin/env bash
# Build a sideloadable Forge Mobile release APK and copy it to release/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE_DIR="$ROOT/apps/mobile"
ANDROID_DIR="$MOBILE_DIR/android"
APP_DIR="$ANDROID_DIR/app"
KEYSTORE="$APP_DIR/debug.keystore"
OUT_DIR="$ROOT/release"

resolve_java_home() {
  if [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/java" ]]; then
    local ver
    ver="$("${JAVA_HOME}/bin/java" -version 2>&1 | awk -F '"' '/version/ {print $2}')"
    case "$ver" in
      17.*|18.*|19.*|2[0-9].*) return 0 ;;
    esac
  fi
  local candidate
  for candidate in \
    "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home" \
    "/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home" \
    "/opt/homebrew/opt/openjdk@17" \
    "/usr/libexec/java_home"
  do
    if [[ "$candidate" == "/usr/libexec/java_home" && -x /usr/libexec/java_home ]]; then
      candidate="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
    fi
    if [[ -n "$candidate" && -x "${candidate}/bin/java" ]]; then
      export JAVA_HOME="$candidate"
      return 0
    fi
  done
  echo "error: need JDK 17+ for Android builds (JAVA_HOME)" >&2
  exit 1
}

resolve_android_sdk() {
  local candidate
  for candidate in \
    "${ANDROID_HOME:-}" \
    "${ANDROID_SDK_ROOT:-}" \
    "/opt/homebrew/share/android-commandlinetools" \
    "${HOME}/Library/Android/sdk" \
    "/usr/local/share/android-commandlinetools"
  do
    if [[ -n "$candidate" && -d "${candidate}/platforms" && -d "${candidate}/build-tools" ]]; then
      export ANDROID_HOME="$candidate"
      export ANDROID_SDK_ROOT="$candidate"
      return 0
    fi
  done
  echo "error: Android SDK not found. Install via: brew install --cask android-commandlinetools" >&2
  echo "  expected e.g. /opt/homebrew/share/android-commandlinetools" >&2
  exit 1
}

cd "$ROOT"

resolve_java_home
resolve_android_sdk
export PATH="${JAVA_HOME}/bin:${ANDROID_HOME}/platform-tools:${PATH}"

echo "==> JAVA_HOME=${JAVA_HOME}"
echo "==> ANDROID_HOME=${ANDROID_HOME}"
printf 'sdk.dir=%s\n' "${ANDROID_HOME}" > "${ANDROID_DIR}/local.properties"

echo "==> build mobile workspace packages"
pnpm --filter @forge/mobile-crypto --filter @forge/mobile-protocol run build

VERSION="$(node -p 'require(process.argv[1]).version' "$MOBILE_DIR/package.json")"
ARTIFACT="Forge-${VERSION}-android.apk"

if [[ ! -f "$KEYSTORE" ]]; then
  echo "==> generate debug.keystore (release uses debug signing for internal sideload)"
  keytool -genkeypair \
    -v \
    -storetype JKS \
    -keystore "$KEYSTORE" \
    -alias androiddebugkey \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass android \
    -keypass android \
    -dname "CN=Android Debug,O=Android,C=US"
fi

echo "==> gradle assembleRelease"
cd "$ANDROID_DIR"
chmod +x ./gradlew
./gradlew assembleRelease \
  --no-daemon \
  -PreactNativeArchitectures=armeabi-v7a,arm64-v8a

APK_SRC="$APP_DIR/build/outputs/apk/release/app-release.apk"
if [[ ! -f "$APK_SRC" ]]; then
  echo "error: expected APK missing: $APK_SRC" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cp "$APK_SRC" "$OUT_DIR/$ARTIFACT"
echo "==> wrote $OUT_DIR/$ARTIFACT"
ls -lh "$OUT_DIR/$ARTIFACT"
echo ""
echo "扫码安装: pnpm serve:mobile:android"
echo "打包并发布: pnpm publish:mobile:android"
