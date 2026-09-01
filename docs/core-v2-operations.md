# Forge Core v2 Operations

## Capabilities

Clients should call `system.capabilities` and require `core.execution.v2` before using typed run APIs.

## Backup and restore

```bash
pnpm core:v2:backup -- --data-dir ~/.forge-agent/data backup.tar.gz
pnpm core:v2:restore -- --data-dir ~/.forge-agent/data backup.tar.gz
```

## Legacy gate

```bash
pnpm exec tsx scripts/core-v2/assert-no-legacy.ts
```

The gate blocks new client usage of legacy daemon RPC symbols outside the transitional allowlist.

## Smoke

```bash
pnpm smoke
```

Validates build, daemon startup, ping, and v2 capability discovery when available.
