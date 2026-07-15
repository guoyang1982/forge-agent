# Runtime-neutral session timeline and live file changes

## Context

Forge currently renders a rich desktop timeline, but its durable source of truth is still the model-facing `messages` table. Live tool activity is kept in renderer memory and reconstructed from messages and DOM snapshots after restart. Codex app-server exposes a higher-quality lifecycle model with stable turn/item identifiers, timestamps, and streaming `item/fileChange/patchUpdated` snapshots.

This change introduces a Forge-owned runtime event protocol. Codex is the first reference adapter, Forge Agent emits the same protocol natively, and Cursor, Claude Code, channels, CLI, and future runtimes can consume or produce the same events without changing timeline UI code.

## Goals

1. Show live multi-file edits, current `+N/-N`, and expandable diff within 200 ms of receiving a runtime event.
2. Update one timeline item in place throughout `running -> completed|failed|declined`; never render duplicate completion cards.
3. Persist the event stream so restart restores ordering, statuses, timing, file lists, and diffs exactly.
4. Keep `messages` as model context and `session_events` as UI history; neither is reconstructed from the other when event history exists.
5. Allow runtime discovery to remain automatic while protocol-specific behavior lives behind adapters or declarative manifests.

## Non-goals

- Implementing new Cursor or Claude Code protocol integrations in this phase.
- Replacing the existing message compaction model.
- Removing legacy timeline reconstruction until existing sessions age out.
- Requiring every runtime to support streaming patches. Tool-result and workspace-diff fallbacks remain valid.

## Architecture

```text
Codex / Forge / ACP / future runtime
              |
         Runtime adapter
              |
      Forge AgentEvent protocol
              |
      append-only session_events
              |
       timeline item reducer
              |
 Desktop first; CLI/channels can consume later
```

### Standard file-change payload

```ts
interface RuntimeFileChange {
  path: string;
  kind: "add" | "update" | "delete";
  unifiedDiff?: string;
  adds: number;
  dels: number;
}

interface RuntimeFileChangeEvent {
  type: "runtime_activity";
  runtime: string;
  activityKind: "file";
  status: "running" | "done" | "failed" | "declined";
  callId: string;
  turnId?: string;
  startedAtMs?: number;
  completedAtMs?: number;
  durationMs?: number;
  changes: RuntimeFileChange[];
}
```

Single-file compatibility fields (`path`, `adds`, `dels`, `patch`) remain during migration and are derived from the first change. New code consumes `changes` first.

### Runtime capability declaration

```ts
interface RuntimeCapabilities {
  itemLifecycle: boolean;
  streamingText: boolean;
  streamingReasoning: boolean;
  streamingPatch: boolean;
  commandOutput: boolean;
  permissions: boolean;
  subagents: boolean;
}
```

Adapters use the best available source in this order:

1. Native structured lifecycle and patch events.
2. Tool arguments and tool results.
3. Checkpoint/workspace diff polling as fallback.

## Persistence

Add `session_events`:

```sql
CREATE TABLE session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_index INTEGER,
  event_type TEXT NOT NULL,
  item_id TEXT,
  payload TEXT NOT NULL,
  emitted_at_ms INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_session_events_session_seq
  ON session_events(session_id, id);
```

Events are appended before they are broadcast. `get_session_messages` returns `events` alongside messages for backwards compatibility. Truncating a turn removes events at and after that turn. Compaction removes event history whose turn ordinals no longer match retained messages; legacy reconstruction remains the fallback.

## Codex reference adapter

- `item/started`: create a stable running item using `item.id`, `turnId`, and `startedAtMs`.
- `item/fileChange/patchUpdated`: replace the current `changes[]` snapshot for that item; do not append diff fragments.
- `item/completed`: finalize the same item and preserve the final full `changes[]`.
- `turn/diff/updated`: optional turn-level aggregate view; it does not replace item-level data.
- `emittedAtMs`: retained as the server emission timestamp when present.

## Forge Agent adapter

`write_file` and `write_patch` already know the target path and unified diff before apply. They emit the standard running file activity before application and finalize it after success, pending confirmation, or failure. Existing `patch_proposed` remains temporarily for permission and backwards compatibility, but the desktop timeline does not render a second card.

## Desktop behavior

- One file: `正在编辑 app.ts  +12 -3`.
- Multiple files: `正在修改 3 个文件  +68 -14`, expandable to one row per file.
- Stats update in place and are paint-throttled; the reducer receives every event.
- Completion preserves the expandable full diff and duration.
- If persisted events exist, restoration replays them. Otherwise the current message reconstruction path is unchanged.
- Absolute timestamps remain in details/hover; elapsed duration stays in the compact timeline.

## Failure and rollback

- Malformed events are skipped and logged without breaking the run.
- Event persistence failure must not stop model execution; broadcast continues with a warning log.
- Unknown event fields are retained in JSON and ignored by older clients.
- Rollback is migration-safe: old code ignores `session_events`; the new code falls back when the table has no rows.

## Acceptance criteria

1. A Codex `patchUpdated` event updates the existing file card with all changed files and accurate aggregate `+N/-N`.
2. Ten updates followed by completion produce one timeline card, not eleven.
3. A two-file FileChange renders both files and both diffs.
4. Forge `write_file` and `write_patch` emit the same normalized file-change shape.
5. Closing and reopening the desktop restores event order, terminal statuses, timing, file lists, and diffs from `session_events`.
6. Sessions created before the migration still restore through the existing message reconstruction path.
7. Timeline update work is scheduled within 200 ms of receiving a file-change event.
8. Unit tests cover diff statistics, Codex mapping, persistence ordering/truncation, and reducer idempotency.
9. Existing daemon, session, protocol, and desktop tests pass.

## Implementation order

1. Protocol types and database migration.
2. Event persistence and retrieval.
3. Codex streaming multi-file mapping.
4. Forge native file-change emission.
5. Desktop reducer/render/restore.
6. Compatibility cleanup after telemetry shows old sessions are no longer common.

