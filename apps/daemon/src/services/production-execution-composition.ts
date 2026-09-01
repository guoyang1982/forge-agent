import {
  DurableExecutor,
  ExecutionRecovery,
  ExecutionStore,
  LegacyForgeStepExecutor,
  StepExecutorRegistry,
  type ExecutionClock,
  type LegacyForgeRunFn,
} from "@forge/execution";
import { EventStore } from "@forge/event-store";
import type { EventEnvelope } from "@forge/protocol";
import { createProductionEventSink } from "./core-event-sink.js";

export interface CoreEventDeliveryFailure {
  event: EventEnvelope;
  error: Error;
}

export interface CoreEventDeliveryFailureSource {
  onCoreEventBroadcastFailure(
    listener: (failure: CoreEventDeliveryFailure) => void,
  ): () => void;
}

export interface ProductionExecutionCompositionOptions {
  db: ConstructorParameters<typeof EventStore>[0];
  clock: ExecutionClock;
  run: LegacyForgeRunFn;
  broadcast(event: EventEnvelope): void;
  onDeliveryFailure?(failure: CoreEventDeliveryFailure): void;
}

/** Production-only durable execution wiring, shared by main and socket e2e tests. */
export function createProductionExecutionComposition(
  options: ProductionExecutionCompositionOptions,
) {
  const eventStore = new EventStore(options.db);
  let executionStore!: ExecutionStore;
  const eventSink = createProductionEventSink({
    events: eventStore,
    getCorrelationId: (runId) => executionStore.getRun(runId)?.correlationId,
    broadcast: options.broadcast,
    reportDeliveryFailure: (event, error) => {
      options.onDeliveryFailure?.({ event, error });
    },
    now: options.clock.now,
  });
  executionStore = new ExecutionStore(options.db, eventSink.appendInTransaction, {
    onCommitted: eventSink.flush,
    onRolledBack: eventSink.discard,
  });
  const stepExecutors = new StepExecutorRegistry();
  stepExecutors.register(
    new LegacyForgeStepExecutor({
      emitLegacyAgentEvent: eventSink.emitLegacyAgentEvent,
      run: options.run,
    }),
  );
  const executor = new DurableExecutor(executionStore, stepExecutors, options.clock);
  const executionRecovery = new ExecutionRecovery(
    executionStore,
    stepExecutors,
    options.clock,
  );

  return {
    eventStore,
    executionStore,
    executor,
    executionRecovery,
    observeDeliveryFailures(source: CoreEventDeliveryFailureSource): () => void {
      if (!options.onDeliveryFailure) return () => undefined;
      return source.onCoreEventBroadcastFailure(options.onDeliveryFailure);
    },
  };
}
