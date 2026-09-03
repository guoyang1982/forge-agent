# Forge Core v2 Migration Report

## Scope

Assets/Connectors sub-plan Tasks 1–12 and review remediation Task 8 on branch `codex/core-v2-f0c-execution`.

## Delivered packages

| Area | Package / surface |
|------|-------------------|
| Assets | `@forge/asset-registry` |
| Workflows | `@forge/workflows` v2 compiler/store/triggers |
| Automation | `@forge/automation` v2 adapter |
| Knowledge | `@forge/memory` `KnowledgeStore` |
| Memory | `@forge/memory` `MemoryStoreV2` |
| Runtime | `@forge/agent-core` dynamic status + compression |
| Connectors | `@forge/connectors` gateway |
| Clients | Desktop/CLI/Mobile keep `run` / `cancel_run`; kernel `run.create` for automation |

## Client migration (Task 8)

Core v2 is the **execution/governance kernel**, not a product RPC rewrite. First-party Desktop / CLI / Mobile keep the existing `run` / `cancel_run` contract. The daemon opens a durable `core_runs` row, binds that RPC's `emit` to the `runId`, waits for a terminal state, and returns `{ sessionId, finalText }`. Chat sets `policyContext.origin = "first-party-chat"` and skips the governed executor; automation, recovery, and tests still call `run.create`.

- Desktop `forge:run` / `forge:cancel-run` call `DAEMON_METHODS.RUN` / `CANCEL_RUN`
- CLI REPL sends SIGINT to `cancel_run` with the known `sessionId`
- Channel `ForgeBridge` already used `RUN`; no product-path change
- Mobile first-party `run.start` / `run.cancel` use `RUN` + onEvent, not `run.create` polling

`run.create` / `run.get` / `run.cancel` remain for automation, recovery, smoke, and future A2A. `handleRun` must not call `createRun` (no wrap-around). `pnpm core:v2:legacy-gate` allowlists the first-party client trees that still use `RUN` / `CANCEL_RUN`.

## Smoke and gates

```bash
CI=true pnpm build
CI=true pnpm test
pnpm core:v2:legacy-gate
pnpm core:v2:test
bash scripts/smoke-test.sh
```

Smoke (`FORGE_SMOKE=1` on the daemon) asserts:

- `system.capabilities.protocolVersion === 2`
- `core.execution.v2` feature present
- kernel `run.create` → persisted events → terminal `succeeded` → non-empty `sessionId` / `finalText`

Product chat is a separate path: `run` must insert `core_runs` with `origin: "first-party-chat"`, stream AgentEvents, and map `cancel_run` to `CORE_CANCELLED`.

Windows: `pwsh -NoProfile -File scripts/smoke-test.ps1`

## Migration rehearsal

Use an isolated copy of `data.db` only. Record:

- source checksum
- `schema_migrations` versions through latest core migration
- row counts for `core_assets`, `core_workflow_versions`, `core_knowledge_sources`, `core_runs`
- sample run IDs before/after restore

Commands:

```bash
pnpm core:v2:backup -- --data-dir ~/.forge-agent/data backup.tar.gz
pnpm core:v2:restore -- --data-dir ~/.forge-agent/data-restore backup.tar.gz
```

Rehearsal checklist:

1. Copy v1/v2 fixture database to a temp data dir; record SHA-256 of `data.db`
2. Start daemon; confirm `system.capabilities` reports v2
3. Run `node scripts/core-v2/smoke-v2-run.mjs`; record `runId`, event cursor, `sessionId`
4. `pnpm core:v2:backup` to an archive; record manifest checksum
5. Restore into a fresh directory; verify schema version and row counts match post-upgrade expectations
6. Repeat smoke run; record new `runId` (need not match pre-backup run)

Do not rehearse against a live production database.

## Transitional kernel helpers

`run.create` stays as the automation / recovery / test entry. First-party product code must keep using `run` / `cancel_run`. Typed helpers such as `apps/cli/src/client-v2.ts` and `apps/desktop/src/daemon-v2.ts` are kernel/test utilities, not the product path. `pnpm core:v2:legacy-gate` still blocks accidental legacy usage outside the first-party allowlist.
