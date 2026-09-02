import type { RuntimePolicy } from "@forge/agent-profile";

export type StepOutcome =
  | { state: "succeeded"; outputRef: string }
  | { state: "failed"; error: unknown; retryable: boolean }
  | { state: "waiting"; waitRef: string; payload?: unknown };

export interface StepExecutionInput {
  runId: string;
  stepId: string;
  attemptId: string;
  attemptNumber: number;
  kind: string;
  input: unknown;
  idempotencyKey?: string;
  timeoutMs: number;
  runtimePolicy?: RuntimePolicy;
}

export interface StepExecutor {
  kind: string;
  execute(input: StepExecutionInput, signal: AbortSignal): Promise<StepOutcome>;
  reconcile?(input: StepExecutionInput): Promise<StepOutcome | "unknown">;
}

export class StepExecutorRegistry {
  private readonly executors = new Map<string, StepExecutor>();

  register(executor: StepExecutor): void {
    if (this.executors.has(executor.kind)) {
      throw new Error(`step executor already registered: ${executor.kind}`);
    }
    this.executors.set(executor.kind, executor);
  }

  get(kind: string): StepExecutor | undefined {
    return this.executors.get(kind);
  }
}

export function succeeded(outputRef: string): StepOutcome {
  return { state: "succeeded", outputRef };
}

export function retryable(error: string): StepOutcome {
  return { state: "failed", error, retryable: true };
}
