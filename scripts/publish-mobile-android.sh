#!/usr/bin/env bash
# Build Forge Mobile APK (if needed) and serve it on the LAN with a QR install page.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKIP_BUILD=0
SERVE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --port)
      export PORT="${2:?missing port value}"
      shift 2
      ;;
    --tunnel)
      SERVE_ARGS+=(--tunnel)
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: scripts/publish-mobile-android.sh [--skip-build] [--port 8765] [--tunnel]

  --skip-build   Skip Gradle build; serve the newest APK in release/
  --port         HTTP port for the install page (default 8765)
  --tunnel       Expose a public download URL via cloudflared (for isolated Wi-Fi)
EOF
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

cd "$ROOT"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  bash scripts/pack-mobile-android.sh
fi

exec node scripts/serve-mobile-apk.mjs "${SERVE_ARGS[@]}"
