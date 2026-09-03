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

## Review fix round 1

### Root causes addressed

1. `ProductionEventSink.appendInTransaction()` broadcast before the surrounding `ExecutionStore` transaction committed.
2. The previous daemon event test bypassed `DaemonHost`, `DaemonServer`, and `DaemonClient`, and used an unsafe context cast.
3. `DaemonServer.broadcastCoreEvent()` ignored `socket.write` outcomes and had no observable failure channel.

### RED evidence

- `pnpm --filter @forge/daemon test -- src/production-events.e2e.test.ts` failed the rollback regression: durable state retained only `run.created` and `step.started`, while live broadcasts also contained rolled-back `step.succeeded` and `run.succeeded`.
- `pnpm --filter @forge/bus test -- src/index.test.ts` failed with `server.onCoreEventBroadcastFailure is not a function` after adding the real socket-write-failure regression.

### GREEN changes and evidence

- `ExecutionStore` now invokes an optional transaction observer only after a successful SQLite commit. The sink queues transactional envelopes, flushes only from `onCommitted`, and discards on rollback. The forced later-failure test proves no rolled-back terminal events are broadcast.
- `createProductionExecutionComposition()` is the production seam used by `main.ts`. The daemon e2e now starts a real `DaemonHost`, connects a real `DaemonClient` over a Unix socket, and verifies stored/replayed envelopes exactly match live fan-out without unsafe casts.
- Bus fan-out returns an observable delivery result and exposes `onCoreEventBroadcastFailure()`. Tests verify both a connected client receives the real CoreEvent and a destroyed peer causes a listener-visible write failure.

Passing commands/results:

- `pnpm --filter @forge/protocol run build && pnpm --filter @forge/execution run build && pnpm --filter @forge/bus run build && pnpm --filter @forge/daemon-client run build && pnpm --filter @forge/daemon run build`: all passed.
- `pnpm --filter @forge/execution test`: 58/58 passed.
- `pnpm --filter @forge/bus test`: 8/8 passed.
- `pnpm --filter @forge/daemon-client test`: 11/11 passed, including durable Workbench final-result coverage.
- `pnpm --filter @forge/daemon test -- src/production-events.e2e.test.ts src/host/daemon-host.test.ts src/modules/execution-module.test.ts src/modules/event-module.test.ts`: 19/19 passed.
- `git diff --check`: passed.

## Review fix round 2

### Root causes addressed

1. Async CoreEvent socket-write failures were observable only from `DaemonServer`; production composition had no channel to receive or report them.
2. `ExecutionStore` invokes its commit observer after SQLite commits. The sink could throw from that observer when a synchronous broadcast reported failure, turning durable `run.create` success into an RPC failure before the executor wake.

### RED evidence

- `pnpm --filter @forge/daemon test -- src/production-events.e2e.test.ts` failed the new post-commit regression with `TypeError: fx.host.onCoreEventBroadcastFailure is not a function`, proving that the real Host/production composition could not observe the bus delivery failure.

### GREEN changes and evidence

- `DaemonHost` now relays `DaemonServer` CoreEvent delivery failures through `onCoreEventBroadcastFailure()`. The production composition subscribes to that channel, and `main.ts` registers a production diagnostic reporter. Both callback-reported async write failures and exceptional broadcaster calls use this independent delivery-failure path.
- `ProductionEventSink.flush()` no longer propagates delivery exceptions into the already-committed store operation. The event remains durable; the execution module returns `run.create` success and wakes the executor while delivery failure is reported independently.
- The real Host/Server/Client production e2e creates a doomed Unix-socket peer and proves the failure reaches the composition reporter exactly once while `run.create` succeeds, the run is durable, and `wakeExecutor` was called once.

Passing commands/results:

- `pnpm --filter @forge/daemon run build && pnpm --filter @forge/execution test -- src/store.test.ts && pnpm --filter @forge/daemon-client test && pnpm --filter @forge/daemon test -- src/production-events.e2e.test.ts && pnpm --filter @forge/bus test -- src/index.test.ts`: passed; daemon build succeeded; execution 8/8, daemon-client 11/11, production daemon 4/4, and bus 8/8 tests passed.
- `pnpm --filter @forge/daemon run build && pnpm --filter @forge/daemon test -- src/production-events.e2e.test.ts && pnpm --filter @forge/bus test -- src/index.test.ts && git diff --check`: passed; daemon build succeeded; production daemon 4/4 and bus 8/8 tests passed with no whitespace errors.
- `git diff --check`: passed.
