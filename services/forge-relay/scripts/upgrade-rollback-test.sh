#!/usr/bin/env bash
set -euo pipefail

prefix="forge-relay-upgrade-test"
network="${prefix}-network"
postgres="${prefix}-postgres"
relay="${prefix}-relay"
old_image="${prefix}:0.1.0"
new_image="${prefix}:0.1.1"
port="${FORGE_RELAY_UPGRADE_TEST_PORT:-58080}"
database_url="postgresql://forge_relay:forge_relay_test_password@${postgres}:5432/forge_relay"
work="$(mktemp -d)"

cleanup() {
  docker rm -f "${relay}" "${postgres}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT

docker build --build-arg VERSION=0.1.0 -t "${old_image}" .
docker build --build-arg VERSION=0.1.1 -t "${new_image}" .
docker network create "${network}" >/dev/null
docker run --rm -d --name "${postgres}" --network "${network}" \
  -e POSTGRES_DB=forge_relay \
  -e POSTGRES_USER=forge_relay \
  -e POSTGRES_PASSWORD=forge_relay_test_password \
  postgres:17-alpine >/dev/null

until docker exec "${postgres}" pg_isready -U forge_relay -d forge_relay >/dev/null 2>&1; do
  sleep 1
done

go run ./cmd/keygen -out "${work}/relay-jwt-private.pem" >/dev/null
chmod 0444 "${work}/relay-jwt-private.pem"
docker run --rm --network "${network}" \
  -e FORGE_RELAY_DATABASE_URL="${database_url}" \
  "${old_image}" migrate up

start_relay() {
  local image="$1"
  docker rm -f "${relay}" >/dev/null 2>&1 || true
  docker run -d --name "${relay}" --network "${network}" -p "${port}:8080" \
    -e FORGE_RELAY_PUBLIC_ORIGIN=http://127.0.0.1:${port} \
    -e FORGE_RELAY_DATABASE_URL="${database_url}" \
    -e FORGE_RELAY_ENROLL_TOKEN=upgrade-test-enrollment-token-32-bytes \
    -e FORGE_RELAY_JWT_PRIVATE_KEY_FILE=/run/secrets/relay-jwt-private.pem \
    -v "${work}/relay-jwt-private.pem:/run/secrets/relay-jwt-private.pem:ro" \
    "${image}" >/dev/null
}

assert_version_and_state() {
  local version="$1"
  local health=""
  for _ in $(seq 1 30); do
    health="$(curl -fsS "http://127.0.0.1:${port}/readyz" 2>/dev/null || true)"
    if [[ "${health}" == *"\"version\":\"${version}\""* ]]; then
      break
    fi
    sleep 1
  done
  if [[ "${health}" != *"\"version\":\"${version}\""* ]]; then
    docker logs "${relay}" >&2 || true
    return 1
  fi
}

start_relay "${old_image}"
assert_version_and_state "0.1.0"
go run ./cmd/smoke -mode bootstrap -origin "http://127.0.0.1:${port}" \
  -state "${work}/smoke-state.json" -enroll-token upgrade-test-enrollment-token-32-bytes
start_relay "${new_image}"
assert_version_and_state "0.1.1"
go run ./cmd/smoke -mode resume -origin "http://127.0.0.1:${port}" -state "${work}/smoke-state.json"
start_relay "${old_image}"
assert_version_and_state "0.1.0"
go run ./cmd/smoke -mode resume -origin "http://127.0.0.1:${port}" -state "${work}/smoke-state.json"

echo "Relay image upgrade and rollback test passed"
