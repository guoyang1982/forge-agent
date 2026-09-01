# Task 2 Report — Production v2 Events and Final Results

## Traced call path

`run.create` is registered by `apps/daemon/src/modules/execution-module.ts`, which calls `ExecutionStore.createRun()` and wakes `DurableExecutor`. The executor claims the `forge.agent` step, invokes `LegacyForgeStepExecutor`, and calls `executeLegacyForgeRun()` in the production composition in `apps/daemon/src/main.ts`.

Before this change, `ExecutionStore` already appended `run.*` and `step.*` CoreEvents, and `EventStore` already serialized/replayed them. However, `main.ts` constructed `LegacyForgeStepExecutor` without `emitLegacyAgentEvent`, so the real agent stream was discarded. `DaemonServer` had serialization support but no broadcast operation. `waitForWorkbenchRun()` only populated `sessionId` and `finalText` from received compatibility notifications.

## Root cause and fix

Added `ProductionEventSink` as the executor-independent production bridge. It:

- receives `AgentEvent` plus durable run/step/attempt links;
- appends an `agent.event` CoreEvent containing the compatibility payload before broadcasting the exact stored envelope;
- decorates all `ExecutionStore` CoreEvent appends with the same stored-envelope broadcaster;
- refuses to broadcast if persistence fails.

`main.ts` injects the sink into both `ExecutionStore` and `LegacyForgeStepExecutor`. `DaemonServer`/`DaemonHost` now expose CoreEvent fan-out for connected clients. `agent.event` is advertised as a v2 execution event type.

Workbench streaming remains available for UI updates, while its terminal `sessionId` and `finalText` now come from paged durable `events.read` replay for the run. It no longer treats transient compatibility delivery as the final-result source of truth.

## RED evidence

1. `pnpm --filter @forge/execution exec vitest run src/legacy-run-adapter.test.ts` failed because the optional bridge received only the event and no run/step/attempt links.
2. `pnpm --filter @forge/daemon test -- src/production-events.e2e.test.ts` initially failed because `core-event-sink.ts` did not exist; after wiring the new sink, the first behavioral run exposed stale execution build output. Rebuilding `@forge/execution` produced the expected green integration result.
3. `pnpm --filter @forge/daemon-client exec vitest run src/workbench-api.test.ts` failed with `{ sessionId: "", finalText: "" }` when only a durable `agent.event` was available.

## Files changed

- `apps/daemon/src/main.ts`
- `apps/daemon/src/services/core-event-sink.ts`
- `apps/daemon/src/host/daemon-host.ts`
- `apps/daemon/src/production-events.e2e.test.ts`
- `packages/bus/src/index.ts`
- `packages/execution/src/legacy-run-adapter.ts`
- `packages/execution/src/legacy-run-adapter.test.ts`
- `packages/daemon-client/src/workbench-api.ts`
- `packages/daemon-client/src/workbench-api.test.ts`
- `packages/protocol/src/v2/rpc.ts`

## GREEN verification

Fresh final verification completed successfully:

- Builds: `@forge/protocol`, `@forge/execution`, `@forge/bus`, `@forge/daemon-client`, and `@forge/daemon`.
- Tests: bus 6/6, daemon-client 11/11, execution 58/58, focused daemon 18/18.
- `git diff --check` completed with no whitespace errors.

The production integration test executes `run.create` through the real execution router with a deterministic `reply pong` model boundary. It checks ordered persisted event types/sequences, terminal run state, durable session/final text, live broadcast identity, persistence-before-broadcast failure handling, and replayed IDs/order after a cursor.

## Self-review

- The event broadcast uses the envelope returned by `EventStore`, so live and replay consumers observe the same IDs and sequence numbers.
- The compatibility payload is persisted in `core_events`; v2 final result resolution reads that durable state rather than the legacy socket event channel.
- The existing optional legacy callback remains compatible and is extended only with execution links.
- No protocol types were weakened and persistence/broadcast failures are not swallowed.

## Commit

Implementation commit: `926560a829aded6cbdfa0f99d680fce0f375399a` (`fix(core): wire production v2 event results`).

## Concerns

None. Live clients connected after an event is emitted recover it through the existing durable replay path.
