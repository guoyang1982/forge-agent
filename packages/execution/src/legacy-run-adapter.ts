import { createHash } from "node:crypto";
import type { AgentEvent, RunRequest, RunResult } from "@forge/protocol";
import type { RuntimePolicy } from "@forge/agent-profile";
import type { StepExecutionInput, StepExecutor, StepOutcome } from "./executor-types.js";
import type { RunSpec, StepSpec } from "./types.js";

export const FORGE_AGENT_STEP_KIND = "forge.agent" as const;
export const FIRST_PARTY_RUN_ORIGIN = "first-party-chat";

export function isCompatibilityPolicyContext(
  policyContext: Record<string, unknown>,
): boolean {
  return policyContext.compatibility === true;
}

export function isFirstPartyChatPolicyContext(
  policyContext: Record<string, unknown>,
): boolean {
  return policyContext.origin === FIRST_PARTY_RUN_ORIGIN;
}

export interface IdFactory {
  runId(): string;
  correlationId(): string;
  stepId?(): string;
}

export interface LegacyForgeRunFn {
  (
    request: RunRequest,
    emit: (event: AgentEvent) => void,
    signal: AbortSignal,
    runtimePolicy?: RuntimePolicy,
  ): Promise<RunResult>;
}

export interface LegacyForgeStepExecutorOptions {
  run: LegacyForgeRunFn;
  persistResult?: (result: RunResult, input: StepExecutionInput) => string;
  emitLegacyAgentEvent?: (
    event: AgentEvent,
    links: { runId: string; stepId: string; attemptId: string },
  ) => void;
}

export function runRequestToRunSpec(
  request: RunRequest,
  ids: IdFactory,
): RunSpec {
  const runId = ids.runId();
  return {
    id: runId,
    objective: request.message,
    requestedBy: { kind: "human", id: "local-user" },
    actingSubject: { kind: "agent_profile", id: "forge-default" },
    correlationId: ids.correlationId(),
    policyContext: { compatibility: true },
    steps: [compatibilityStep(runId, request, ids)],
  };
}

export function compatibilityStep(
  runId: string,
  request: RunRequest,
  ids: IdFactory,
): StepSpec {
  return {
    id: ids.stepId?.() ?? `${runId}:forge-agent`,
    kind: FORGE_AGENT_STEP_KIND,
    dependsOn: [],
    input: legacyRunInputFromRequest(request),
    idempotencyKey: request.sessionId ?? undefined,
    retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
    timeoutMs: 3_600_000,
  };
}

export function legacyRunInputFromRequest(request: RunRequest): RunRequest {
  return {
    cwd: request.cwd,
    message: request.message,
    sessionId: request.sessionId,
    runtime: request.runtime,
    clientRunId: request.clientRunId,
    hookSource: request.hookSource,
    automationRun: request.automationRun,
    channelRun: request.channelRun,
    autoApply: request.autoApply,
    files: request.files,
    attachments: request.attachments,
  };
}

export function parseLegacyRunRequest(input: unknown): RunRequest {
  if (!input || typeof input !== "object") {
    throw new Error("legacy run step input must be an object");
  }
  const value = input as Partial<RunRequest>;
  if (typeof value.cwd !== "string" || typeof value.message !== "string") {
    throw new Error("legacy run step input requires cwd and message");
  }
  return legacyRunInputFromRequest(value as RunRequest);
}

export function finalTextToArtifactRef(
  sessionId: string,
  finalText: string,
): string {
  const digest = createHash("sha256").update(finalText).digest("hex").slice(0, 16);
  return `artifact:session:${sessionId}:${digest}`;
}

export function bridgeLegacyAgentEvent(
  event: AgentEvent,
  links: { runId: string; stepId: string; attemptId: string; correlationId: string },
): Record<string, unknown> {
  return {
    compatibility: true,
    legacyEventType: event.type,
    runId: links.runId,
    stepId: links.stepId,
    attemptId: links.attemptId,
    correlationId: links.correlationId,
    sessionId: "sessionId" in event ? event.sessionId : undefined,
  };
}

export class LegacyForgeStepExecutor implements StepExecutor {
  readonly kind = FORGE_AGENT_STEP_KIND;

  constructor(private readonly options: LegacyForgeStepExecutorOptions) {}

  async execute(
    input: StepExecutionInput,
    signal: AbortSignal,
  ): Promise<StepOutcome> {
    if (signal.aborted) {
      return {
        state: "failed",
        error: { code: "CORE_CANCELLED" },
        retryable: false,
      };
    }

    const request = parseLegacyRunRequest(input.input);
    const emit = (event: AgentEvent) => {
      this.options.emitLegacyAgentEvent?.(event, {
        runId: input.runId,
        stepId: input.stepId,
        attemptId: input.attemptId,
      });
    };

    try {
      const result = await this.options.run(
        request,
        emit,
        signal,
        input.runtimePolicy,
      );
      return {
        state: "succeeded",
        outputRef:
          this.options.persistResult?.(result, input) ??
          finalTextToArtifactRef(result.sessionId, result.finalText),
      };
    } catch (error) {
      if (signal.aborted) {
        return {
          state: "failed",
          error: { code: "CORE_CANCELLED" },
          retryable: false,
        };
      }
      return {
        state: "failed",
        error,
        retryable: false,
      };
    }
  }
}
