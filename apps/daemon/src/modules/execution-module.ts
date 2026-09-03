import type { RunSpec } from "@forge/protocol";
import { rpcFault } from "@forge/protocol";
import type { DaemonModule } from "../host/types.js";
import { RpcFaultError, TypedRouter } from "../host/router.js";
import type {
  DurableExecutor,
  ExecutionClock,
  ExecutionRecovery,
  ExecutionStore,
} from "@forge/execution";
import type { ForgeDaemonContext } from "./context.js";

export interface ExecutionModuleContext {
  executionStore: ExecutionStore;
  executionClock: ExecutionClock;
  executor: DurableExecutor;
  executionRecovery: ExecutionRecovery;
  wakeExecutor(): void;
}

export function createExecutionModule(): DaemonModule<ForgeDaemonContext> {
  return {
    id: "execution",
    feature: { version: 1, enabled: true },
    register(router, context) {
      router.register("run.create", async (spec, rpc) =>
        handleRunCreate(spec, context, rpc.correlationId),
      );
      router.register("run.get", async (params, rpc) =>
        handleRunGet(params.runId, context, rpc.correlationId),
      );
      router.register("run.cancel", async (params, rpc) =>
        handleRunCancel(params, context, rpc.correlationId),
      );
      router.register("run.resume", async (params, rpc) =>
        handleRunResume(params, context, rpc.correlationId),
      );
    },
    start: async (context) => {
      await context.executionRecovery.recoverOnStartup();
    },
  };
}

async function handleRunCreate(
  spec: RunSpec,
  context: ForgeDaemonContext,
  correlationId: string,
) {
  validateRunSpec(spec, correlationId);
  const created = context.executionStore.createRun(spec, context.executionClock.now());
  context.wakeExecutor();
  return { runId: created.id, state: created.state };
}

async function handleRunGet(
  runId: string,
  context: ForgeDaemonContext,
  correlationId: string,
) {
  if (!runId) {
    throw invalidRequest("runId is required", correlationId);
  }
  const run = context.executionStore.getRun(runId);
  if (!run) {
    throw invalidRequest("run not found", correlationId);
  }
  return {
    runId: run.id,
    state: run.state,
    objective: run.spec.objective,
    correlationId: run.correlationId,
    steps: run.spec.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      state: context.executionStore.getStep(run.id, step.id)?.state ?? "pending",
    })),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

async function handleRunCancel(
  params: { runId?: string; sessionId?: string; reason?: string },
  context: ForgeDaemonContext,
  correlationId: string,
) {
  if (params.runId) {
    context.executor.cancelRun(params.runId, params.reason ?? "cancelled by client");
    for (const sessionId of context.cancelService.activeSessionIds()) {
      context.cancelService.cancel(sessionId);
    }
    const run = context.executionStore.getRun(params.runId);
    if (!run) {
      throw invalidRequest("run not found", correlationId);
    }
    return { ok: true as const, runId: run.id, state: run.state };
  }
  if (params.sessionId) {
    const canceled = context.firstPartyRuns.cancel(params.sessionId);
    return {
      ok: true as const,
      runId: params.sessionId,
      state: canceled.canceled ? ("cancelled" as const) : ("running" as const),
    };
  }
  throw invalidRequest("runId or sessionId is required", correlationId);
}

async function handleRunResume(
  params: { waitId: string; payload: unknown },
  context: ForgeDaemonContext,
  correlationId: string,
) {
  if (!params.waitId) {
    throw invalidRequest("waitId is required", correlationId);
  }
  context.executor.resumeWait(params.waitId, params.payload);
  context.wakeExecutor();
  return { ok: true as const, waitId: params.waitId };
}

function validateRunSpec(spec: RunSpec, correlationId: string): void {
  if (!isRecord(spec)) {
    throw invalidRequest("run spec must be an object", correlationId);
  }
  if (typeof spec.id !== "string" || !spec.id) {
    throw invalidRequest("run spec id is required", correlationId);
  }
  if (typeof spec.objective !== "string" || !spec.objective) {
    throw invalidRequest("run spec objective is required", correlationId);
  }
  if (typeof spec.correlationId !== "string" || !spec.correlationId) {
    throw invalidRequest("run spec correlationId is required", correlationId);
  }
  if (!isRecord(spec.policyContext)) {
    throw invalidRequest("run spec policyContext must be an object", correlationId);
  }
  validateSubjectRef(spec.requestedBy, "requestedBy", correlationId);
  validateSubjectRef(spec.actingSubject, "actingSubject", correlationId);
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    throw invalidRequest("run spec requires at least one step", correlationId);
  }
  for (const step of spec.steps) {
    validateStepSpec(step, correlationId);
  }
}

function validateStepSpec(step: unknown, correlationId: string): void {
  if (!isRecord(step)) {
    throw invalidRequest("step spec must be an object", correlationId);
  }
  if (typeof step.id !== "string" || !step.id) {
    throw invalidRequest("step id is required", correlationId);
  }
  if (typeof step.kind !== "string" || !step.kind) {
    throw invalidRequest("step kind is required", correlationId);
  }
  if (!Array.isArray(step.dependsOn)) {
    throw invalidRequest("step dependsOn must be an array", correlationId);
  }
  if (!isRecord(step.retry)) {
    throw invalidRequest("step retry policy is required", correlationId);
  }
  if (
    !Number.isFinite(step.retry.maxAttempts) ||
    !Number.isFinite(step.retry.backoffMs) ||
    !Number.isFinite(step.retry.maxBackoffMs)
  ) {
    throw invalidRequest("step retry policy is invalid", correlationId);
  }
  if (
    typeof step.timeoutMs !== "number" ||
    !Number.isFinite(step.timeoutMs) ||
    step.timeoutMs <= 0
  ) {
    throw invalidRequest("step timeoutMs must be positive", correlationId);
  }
}

function validateSubjectRef(
  subject: unknown,
  label: string,
  correlationId: string,
): void {
  if (!isRecord(subject)) {
    throw invalidRequest(`${label} must be an object`, correlationId);
  }
  if (typeof subject.kind !== "string" || !subject.kind) {
    throw invalidRequest(`${label}.kind is required`, correlationId);
  }
  if (typeof subject.id !== "string" || !subject.id) {
    throw invalidRequest(`${label}.id is required`, correlationId);
  }
}

function invalidRequest(message: string, correlationId: string): RpcFaultError {
  return new RpcFaultError(
    rpcFault("INVALID_REQUEST", message, { correlationId }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Test helper: register handlers without module lifecycle. */
export function registerExecutionHandlers(
  router: TypedRouter,
  context: ForgeDaemonContext,
): void {
  createExecutionModule().register(router, context);
}
