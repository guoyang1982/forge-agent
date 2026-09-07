# Forge Core v2 Migration Report

> Validation status: **implementation verified; ready for commit and human acceptance**
> Last verified: 2026-09-07 (`codex/core-v2-f0c-execution`, `116c86c` plus reviewed uncommitted closeout changes)

## Scope

Assets/Connectors sub-plan Tasks 1–12 and review remediation Tasks 1–8 on branch `codex/core-v2-f0c-execution`. “Delivered” below means the package/API exists; release readiness is controlled by the verification matrix and open blockers in this document.

## 2026-09-07 verification matrix

| Area | Status | Verified behavior | Remaining work |
|------|--------|-------------------|----------------|
| Build, tests and legacy gate | ✅ Pass | Root build, complete root tests and forbidden legacy-symbol gate pass | Commit the remaining reviewed changes |
| Execution governance | ✅ Pass | Required governance, validators, approval expiry/consumption, parameter hash/risk binding, `uncertain` fencing, and exact Asset/Connector/Dead-letter authorization binding | Preserve these invariants as new governed domains are added |
| Automation governance | ✅ Pass | Manual, CLI, scheduled and `skipConfirm` execution all require a pre-existing external grant with exact policy, subject, action, workspace and expiry matching | Keep grant issuance in an explicit external approval flow; automation execution must remain fail closed |
| Event store and cursor | ✅ Pass | Append/outbox transaction, bounded cursors, lease ownership, handler-before-ack, ordered replay; production dispatcher performs startup recovery, ACK, exponential-backoff retry and terminal failure handling, and stops before the Daemon closes storage | Add operator-facing delivery metrics only when product observability is implemented |
| Workflow triggers | ✅ Pass | Claim token, heartbeat, recovery and takeover fencing; expired leases cannot heartbeat/complete/fail; concurrency reads the instance workflow version; changed automation definitions publish a new governed version | Add product-level visibility for trigger recovery when the operator UI is implemented |
| Dead-letter replay | ✅ Pass | Active grant is bound to the exact actor, action, workflow and dead-letter instance; authorization and replay mutation share one transaction; one successful replay per instance/idempotency key | Add product-level replay approval UI only when the operator workflow is implemented |
| Asset publication | ✅ Pass | Publish grants and validations bind active policy, owner subject, action, asset and stable asset-version resource; rollback grants bind actor, asset and target version; missing scopes fail closed | Preserve these bindings when adding external approval UI and audit views |
| Connectors | ✅ Pass | Proposal CAS; exact approval binding and atomic consumption; credentials resolved per operation and zeroed; post-dispatch exceptions fenced as `unknown`; repeat execution blocked; budget held and settled through reconciliation; unknown/reconciled events emitted | Add product-level reconciliation queue and operator UI when Connector management is exposed |
| Artifact storage | ✅ Pass | Traversal and duplicate rejection; artifact root and every child reject symbolic links; directories are created one segment at a time; writes use exclusive temporary files, sync and atomic rename; reads use `O_NOFOLLOW` handles and verify regular-file/hash invariants | Preserve the secure filesystem primitives when adding remote artifact backends |
| Scope isolation | ✅ Pass | Core exposes generic required `tenantId` plus optional `organizationId`; new memory/knowledge writes fail closed without a tenant, reads isolate both boundaries, and migration 027 maps legacy company data and local unscoped data into explicit scopes | Forge Company should map `companyId` to `organizationId` at its adapter boundary |
| Trace/token/cost | ✅ Package tests pass | Durable trace/span metadata and token/cost fields | Add end-to-end product acceptance after blockers close |
| Channel Gateway | ✅ Pass | Test fixtures use the shared `data.db`; concurrent first-party `run` events remain attached to their originating request | Keep first-party Channel on the documented `run` contract |

## Verification closure

No frozen-scope implementation blocker remains. Root build/tests, Core v2 tests (including backup/restore), legacy gate, migration upgrade tests, security regression tests and Smoke passed on 2026-09-07. Commit/release packaging and product-level human acceptance remain operational steps, not additional Core v2 features.

## Delivered packages

| Area | Package / surface |
|------|-------------------|
| Assets | `@forge/asset-registry` |
| Workflows | `@forge/workflows` v2 compiler/store/triggers |
| Automation | `@forge/automation` durable adapter |
| Knowledge | `@forge/memory` `KnowledgeStore` |
| Memory | `@forge/memory` `GovernedMemoryStore` |
| Runtime | `@forge/agent-core` dynamic status + compression |
| Connectors | `@forge/connectors` gateway |
| Clients | Desktop/CLI/Mobile keep `run` / `cancel_run`; kernel `run.create` for automation |

## Client migration (Task 8)

Core v2 is the **execution/governance kernel**, not a product RPC rewrite. First-party Desktop / CLI / Mobile keep the existing `run` / `cancel_run` contract. The daemon opens a durable `core_runs` row, binds that RPC's `emit` to the `runId`, waits for a terminal state, and returns `{ sessionId, finalText }`. Chat sets `policyContext.origin = "first-party-chat"` and skips the governed executor. `compatibility: true` on event payloads marks a bridged AgentEvent; it is not a governance bypass. Automation still goes through `prepare()` plus the governed executor. Recovery and tests still call `run.create`.

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

`run.create` stays as the automation / recovery / test entry. First-party product code must keep using `run` / `cancel_run`. Kernel callers use `@forge/daemon-client` (`createWorkbenchDaemonApi`, `simpleRunSpec`). `pnpm core:v2:legacy-gate` still blocks accidental legacy usage outside the first-party allowlist.
