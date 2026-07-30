# Forge Relay

The Relay is a standalone Go service for connecting Forge hosts and mobile
clients over public WSS. It authenticates the outer connection and forwards
opaque E2EE frames; it must never parse or persist Mobile RPC payloads.

## Production (Aliyun)

Step-by-step ECS + domain + Desktop/mobile connection guide:

- [deploy/RUNBOOK.md](deploy/RUNBOOK.md) — **上线后运维手册**（日常操作、发版更新、排障）
- [deploy/DEPLOY-aliyun.md](deploy/DEPLOY-aliyun.md) — clone on server / standard compose
- [deploy/DEPLOY-aliyun-ssh.md](deploy/DEPLOY-aliyun-ssh.md) — rsync local tree over SSH (`deploy/ssh-sync.sh`)

## Local deployment

1. Copy `deploy/.env.example` to `deploy/.env` and replace every secret.
2. Create the signing key without a passphrase:

   ```sh
   mkdir -p deploy/secrets
   go run ./cmd/keygen -out deploy/secrets/relay-jwt-private.pem
   ```

   The production secret mount must remain private while being readable by the
   container's numeric user `65532:65532` (for example owner `65532`, mode
   `0400`). Do not make a production private key world-readable.

3. Run reviewed migrations, then start the stack:

   ```sh
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm migrate
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d relay caddy
   ```

The migration command is deliberately separate. Starting `forge-relay` never
applies schema changes automatically.

## Development checks

```sh
make fmt-check vet test race
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/forge-relay-amd64 ./cmd/relay
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o /tmp/forge-relay-arm64 ./cmd/relay
./scripts/upgrade-rollback-test.sh
```

The upgrade test builds two versioned images and exercises a real flow against
one PostgreSQL database: enrollment, host proof, invite connection, opaque data
splice, resume installation, new-image resume, then old-image rollback resume.
All containers, networks, private keys, and credential state are temporary.

Required runtime variables are documented in
`docs/superpowers/plans/2026-07-15-mobile-relay.md`. Only `/healthz`, `/readyz`,
`/metrics`, and the versioned `/v1` API should be exposed through Caddy.

The CI vulnerability scanner is pinned to the full signed commit for
`trivy-action` v0.36.0. Do not loosen it to a mutable version tag: older Action
tags were force-pushed during GHSA-69fq-xp46-6x23 in March 2026.
