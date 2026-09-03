# Forge Core v2 Operations

## Capabilities

Typed kernel callers (`run.create`, automation, smoke) should call `system.capabilities` and require `core.execution.v2`. First-party Desktop / CLI / Mobile keep `run` / `cancel_run`; the daemon still persists those turns as durable runs.

## Backup and restore

```bash
pnpm core:v2:backup -- --data-dir ~/.forge-agent/data backup.tar.gz
pnpm core:v2:restore -- --data-dir ~/.forge-agent/data backup.tar.gz
```

## Legacy gate

```bash
pnpm exec tsx scripts/core-v2/assert-no-legacy.ts
```

The gate blocks accidental legacy RPC usage outside the allowlist. First-party Desktop / CLI / Mobile / Channel / `packages/channel-mobile` are allowlisted because product chat keeps `run` / `cancel_run`.

## Smoke

```bash
pnpm smoke
```

Validates build, daemon startup (`FORGE_SMOKE=1`), ping, protocol v2 capability, and a kernel `run.create` durable run with persisted events plus terminal output. Product chat (`run` / `cancel_run`) is covered by daemon first-party unit tests, not this smoke script.

Windows:

```bash
pnpm smoke:win
```
