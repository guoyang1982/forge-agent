#!/usr/bin/env bash
# Sync local forge-relay tree to a remote host over SSH.
# Prefers rsync when the remote has it; otherwise uses tar-over-ssh.
# Does NOT sync (or wipe) deploy/.env or deploy/secrets/ on the server.
#
# Usage:
#   ./deploy/ssh-sync.sh user@host [/remote/path]
#   SSH_KEY=~/.ssh/id_ed25519 ./deploy/ssh-sync.sh root@1.2.3.4 /opt/forge-relay
set -euo pipefail

REMOTE_HOST="${1:?usage: $0 user@host [remote_dir]}"
REMOTE_DIR="${2:-/opt/forge-relay}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SSH_ARGS=(-o StrictHostKeyChecking=accept-new)
if [[ -n "${SSH_KEY:-}" ]]; then
  SSH_ARGS+=(-i "$SSH_KEY")
fi

echo "sync: ${ROOT}/ -> ${REMOTE_HOST}:${REMOTE_DIR}/"
ssh "${SSH_ARGS[@]}" "$REMOTE_HOST" "mkdir -p $(printf '%q' "$REMOTE_DIR")"

sync_with_rsync() {
  local rsh="ssh ${SSH_ARGS[*]}"
  rsync -avz --delete \
    -e "$rsh" \
    --exclude '.git/' \
    --exclude 'deploy/.env' \
    --exclude 'deploy/secrets/' \
    --exclude 'bin/' \
    --exclude '*.test' \
    --exclude '.DS_Store' \
    "${ROOT}/" "${REMOTE_HOST}:${REMOTE_DIR}/"
}

# Remote extractor reads the tar stream from stdin (must not use a heredoc for the script).
remote_extract_script() {
  cat <<'REMOTE'
set -euo pipefail
KEEP="$(mktemp -d)"
cleanup() { rm -rf "$KEEP"; }
trap cleanup EXIT

mkdir -p "$REMOTE_DIR" "$KEEP/deploy"
if [[ -f "$REMOTE_DIR/deploy/.env" ]]; then
  cp "$REMOTE_DIR/deploy/.env" "$KEEP/deploy/.env"
fi
if [[ -d "$REMOTE_DIR/deploy/secrets" ]]; then
  cp -a "$REMOTE_DIR/deploy/secrets" "$KEEP/deploy/secrets"
fi

find "$REMOTE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar -xzf - -C "$REMOTE_DIR"

mkdir -p "$REMOTE_DIR/deploy"
if [[ -f "$KEEP/deploy/.env" ]]; then
  cp "$KEEP/deploy/.env" "$REMOTE_DIR/deploy/.env"
  chmod 600 "$REMOTE_DIR/deploy/.env" || true
fi
if [[ -d "$KEEP/deploy/secrets" ]]; then
  cp -a "$KEEP/deploy/secrets" "$REMOTE_DIR/deploy/secrets"
fi
echo "extracted to $REMOTE_DIR"
REMOTE
}

sync_with_tar() {
  echo "remote has no rsync; using tar-over-ssh"
  export COPYFILE_DISABLE=1
  local script
  script="$(remote_extract_script)"
  (
    cd "$ROOT"
    tar \
      --exclude='.git' \
      --exclude='deploy/.env' \
      --exclude='deploy/secrets' \
      --exclude='bin' \
      --exclude='.DS_Store' \
      --exclude='*.test' \
      -czf - .
  ) | ssh "${SSH_ARGS[@]}" "$REMOTE_HOST" \
    "REMOTE_DIR=$(printf '%q' "$REMOTE_DIR") bash -c $(printf '%q' "$script")"
}

if ssh "${SSH_ARGS[@]}" "$REMOTE_HOST" 'command -v rsync >/dev/null'; then
  sync_with_rsync
else
  sync_with_tar
fi

echo "done. next on remote:"
echo "  cd ${REMOTE_DIR}"
echo "  docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm migrate"
echo "  docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build postgres relay caddy"
