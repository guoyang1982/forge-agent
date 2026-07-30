#!/usr/bin/env bash
# Restore Electron after macOS Gatekeeper moves it to Trash.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/desktop"

ELECTRON_PKG="$(node -e "console.log(require('path').dirname(require.resolve('electron/package.json')))")"
DIST="$ELECTRON_PKG/dist"
APP="$DIST/Electron.app"

echo "==> reinstall Electron ($(node -e "console.log(require('electron/package.json').version)")) into:"
echo "    $APP"
rm -rf "$APP"
node "$ELECTRON_PKG/install.js"
xattr -cr "$APP" 2>/dev/null || true
xattr -d com.apple.quarantine "$APP" 2>/dev/null || true

if [[ ! -x "$APP/Contents/MacOS/Electron" ]]; then
  echo "error: Electron binary still missing after install" >&2
  exit 1
fi

open -R "$APP"

cat <<EOF

Electron 已重新下载。

接下来请手动放行（必须做一次，否则系统还会删掉）：

1. Finder 已定位到 Electron.app
2. 对 Electron.app 按住 Control 点击（或右键）→「打开」→「打开」
   或：系统设置 → 隐私与安全性 → 拉到下方点「仍要打开」
3. 然后再运行：

   cd $ROOT
   pnpm start:desktop

若再次弹出「已阻止恶意软件并移到废纸篓」，先从废纸篓还原 Electron.app，再重复第 2 步。
EOF
