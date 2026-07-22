#!/usr/bin/env bash
# Build a sideloadable Forge Mobile release APK and copy it to release/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE_DIR="$ROOT/apps/mobile"
ANDROID_DIR="$MOBILE_DIR/android"
APP_DIR="$ANDROID_DIR/app"
KEYSTORE="$APP_DIR/debug.keystore"
OUT_DIR="$ROOT/release"

cd "$ROOT"

echo "==> build mobile workspace packages"
pnpm --filter @forge/mobile-crypto --filter @forge/mobile-protocol run build

VERSION="$(node -p "require('$MOBILE_DIR/package.json').version")"
ARTIFACT="Forge-Mobile-${VERSION}-android.apk"

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
