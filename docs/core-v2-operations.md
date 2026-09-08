# Forge Core v2 Operations

> Release status (2026-09-07): **implementation and automated verification complete; ready for commit and human acceptance**. See `docs/core-v2-migration-report.md` for the authoritative implementation matrix.

## Capabilities

Typed kernel callers (`run.create`, automation, smoke) should call `system.capabilities` and require `core.execution.v2`. First-party Desktop / CLI / Mobile keep `run` / `cancel_run`; the daemon still persists those turns as durable runs.

## Backup and restore

```bash
pnpm core:v2:backup -- --data-dir "$HOME/.forge-agent/data" --output-dir "$HOME/forge-backups"
pnpm core:v2:restore -- --restore-manifest /absolute/path/to/backup/manifest.json --restore-dir "$HOME/forge-restored"
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

## Release gate

Run these commands from a clean worktree and require every command to pass:

```bash
CI=true pnpm build
CI=true pnpm test
pnpm core:v2:legacy-gate
pnpm core:v2:test
pnpm smoke
```

Do not promote a build until the full release gate and backup/restore rehearsal pass against the final reviewed tree.

Memory and knowledge callers must always supply a non-empty `tenantId`. Supply `organizationId` for organization-owned data; a tenant-wide record omits it deliberately. Forge Company adapters translate their `companyId` into `organizationId`. Migration 027 assigns historical unscoped records to the `local` tenant and translates historical `companyId` scopes without making them global.

The Daemon starts the `internal` outbox dispatcher only after its event transport is listening and stops the dispatcher before closing storage. Each claim is leased for crash recovery. Successful delivery is acknowledged; failures use exponential backoff (one second base, sixty-second cap) and become terminal after five attempts. A terminal failure remains durable for operator inspection and must not be silently requeued.

Artifact storage rejects symbolic links at the configured root and within all managed paths. Writes create directories one segment at a time, use exclusive temporary files, sync before atomic rename, and roll back metadata on failure. Reads open with `O_NOFOLLOW`, require a regular file, and verify the stored SHA-256 hash.

Connector actions in `unknown` state must be reconciled through the adapter before any operator creates a replacement proposal. The original proposal and idempotency key remain fenced, and any associated budget reservation remains held until reconciliation produces a confirmed result.

Windows:

```bash
pnpm smoke:win
```

Migration 028 persists Connector proposal previews, including their adapter-classified risk. Execution checks the stored risk against both current policy and the approval's risk. Historical pending proposals without a preview cannot execute: create a new proposal with a new idempotency key and approve it again. Completed actions remain readable and idempotent.

The backup command requires a stopped Daemon (no live database writer) and prints the generated `manifestPath`. Use that exact path with `--restore-manifest`; `--restore-dir` must be a new directory. Backups are directories with checksummed files, not tar archives.
