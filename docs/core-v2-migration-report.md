# Forge Core v2 Migration Report

## Scope

Assets/Connectors sub-plan Tasks 1–12 on branch `codex/core-v2-f0c-execution`.

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
| Clients | Desktop/CLI/Mobile/Channel v2 facades |

## Migration rehearsal

Use an isolated copy of `data.db` only. Record:

- source checksum
- `schema_migrations` versions through `018_core_connectors.sql`
- row counts for `core_assets`, `core_workflow_versions`, `core_knowledge_sources`
- sample run IDs before/after restore

Do not rehearse against a live production database.

## Transitional legacy

`DAEMON_METHODS.RUN` remains as a fallback path in Desktop/CLI until all clients default to v2 runs. The assert-no-legacy gate enforces no new usages outside the allowlist.
