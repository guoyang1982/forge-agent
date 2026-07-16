#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
relay_dir="${repo}/services/forge-relay"
work="$(mktemp -d)"
suffix="$$"
network="forge-mobile-e2e-${suffix}"
postgres="forge-mobile-e2e-postgres-${suffix}"
relay="forge-mobile-e2e-relay-${suffix}"
image="forge-mobile-e2e:${suffix}"
relay_port="${FORGE_MOBILE_E2E_RELAY_PORT:-58082}"
gateway_port="${FORGE_MOBILE_E2E_GATEWAY_PORT:-58787}"
model_port="${FORGE_MOBILE_E2E_MODEL_PORT:-58999}"
enroll_token="mobile-e2e-enrollment-token-32-bytes"
database_url="postgresql://forge_relay:forge_relay_test_password@${postgres}:5432/forge_relay"
daemon_pid=""
model_pid=""

cleanup() {
  if [[ -n "${daemon_pid}" ]]; then kill "${daemon_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${model_pid}" ]]; then kill "${model_pid}" >/dev/null 2>&1 || true; fi
  docker rm -f "${relay}" "${postgres}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
  docker image rm -f "${image}" >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT

cd "${repo}"
pnpm --filter @forge/mobile-crypto run build
pnpm --filter @forge/mobile-protocol run build
pnpm --filter @forge/channel-mobile run build
pnpm --filter @forge/mobile-test-client run build
pnpm --filter @forge/channel-gateway run build
pnpm --filter @forge/daemon run build

docker build -t "${image}" "${relay_dir}"
docker network create "${network}" >/dev/null
docker run --rm -d --name "${postgres}" --network "${network}" \
  -e POSTGRES_DB=forge_relay \
  -e POSTGRES_USER=forge_relay \
  -e POSTGRES_PASSWORD=forge_relay_test_password \
  postgres:17-alpine >/dev/null
until docker exec "${postgres}" pg_isready -U forge_relay -d forge_relay >/dev/null 2>&1; do sleep 1; done

cd "${relay_dir}"
go run ./cmd/keygen -out "${work}/relay-jwt-private.pem" >/dev/null
chmod 0444 "${work}/relay-jwt-private.pem"
docker run --rm --network "${network}" \
  -e FORGE_RELAY_DATABASE_URL="${database_url}" \
  "${image}" migrate up
docker run -d --name "${relay}" --network "${network}" -p "${relay_port}:8080" \
  -e FORGE_RELAY_PUBLIC_ORIGIN="http://127.0.0.1:${relay_port}" \
  -e FORGE_RELAY_DATABASE_URL="${database_url}" \
  -e FORGE_RELAY_ENROLL_TOKEN="${enroll_token}" \
  -e FORGE_RELAY_JWT_PRIVATE_KEY_FILE=/run/secrets/relay-jwt-private.pem \
  -v "${work}/relay-jwt-private.pem:/run/secrets/relay-jwt-private.pem:ro" \
  "${image}" >/dev/null
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${relay_port}/readyz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${relay_port}/readyz" >/dev/null

cat >"${work}/config.json" <<JSON
{
  "model": {
    "provider": "openai",
    "baseUrl": "http://127.0.0.1:${model_port}/v1",
    "apiKey": "mobile-e2e-test-key",
    "name": "mobile-e2e-model"
  },
  "permissions": {
    "channels": { "enabled": true, "create": "allow", "start": "allow", "delete": "allow" },
    "mobile": {
      "enabled": true,
      "pair": "allow",
      "run": "allow",
      "approve": "allow",
      "allowedProjects": ["${repo}"],
      "maxDevices": 3,
      "maxConcurrentRunsPerDevice": 1
    }
  }
}
JSON

cd "${repo}"
FORGE_MOBILE_E2E_MODEL_PORT="${model_port}" \
  node packages/mobile-test-client/scripts/mock-model.mjs >"${work}/model.log" 2>&1 &
model_pid="$!"
FORGE_DATA_DIR="${work}/data" \
FORGE_CONFIG_PATH="${work}/config.json" \
FORGE_CHANNEL_GATEWAY_PORT="${gateway_port}" \
  node apps/daemon/dist/main.js >"${work}/daemon.log" 2>&1 &
daemon_pid="$!"
socket="${work}/data/daemon.sock"
for _ in $(seq 1 50); do
  if [[ -S "${socket}" ]]; then break; fi
  sleep 0.2
done
if [[ ! -S "${socket}" ]]; then
  cat "${work}/daemon.log" >&2
  exit 1
fi

first_log="${work}/first.log"
node packages/mobile-test-client/dist/cli.js \
  --socket "${socket}" \
  --relay-origin "http://127.0.0.1:${relay_port}" \
  --enrollment-token "${enroll_token}" \
  --state "${work}/mobile-state.json" \
  --cwd "${repo}" \
  --message "Mobile E2E cancellation probe" \
  --cancel | tee "${first_log}"
adapter_id="$(sed -n 's/.*"adapterId":"\([^"]*\)".*/\1/p' "${first_log}" | head -1)"
if [[ -z "${adapter_id}" ]]; then echo "failed to capture Mobile adapter id" >&2; exit 1; fi

# A Relay restart must not require reenrollment or repairing. The host control
# connection reconnects independently, then the phone resumes with its existing
# device credentials. Retry only within the bounded recovery window so a broken
# reconnect loop cannot make CI hang indefinitely.
docker restart "${relay}" >/dev/null
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${relay_port}/readyz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${relay_port}/readyz" >/dev/null

second_log="${work}/second.log"
recovered=""
for _ in $(seq 1 30); do
  if node packages/mobile-test-client/dist/cli.js \
    --state "${work}/mobile-state.json" \
    --socket "${socket}" \
    --adapter-id "${adapter_id}" \
    --revoke-after >"${second_log}" 2>&1; then
    recovered="yes"
    cat "${second_log}"
    break
  fi
  sleep 0.5
done
if [[ -z "${recovered}" ]]; then
  cat "${second_log}" >&2
  echo "Mobile host/phone did not recover after Relay restart" >&2
  exit 1
fi
if ! grep -q '"messageCount":1' "${second_log}"; then
  echo "cancelled run history contains duplicate messages" >&2
  exit 1
fi

if node packages/mobile-test-client/dist/cli.js --state "${work}/mobile-state.json"; then
  echo "revoked Mobile resume credential unexpectedly succeeded" >&2
  exit 1
fi

echo "Forge Mobile real Relay end-to-end and restart recovery test passed"
