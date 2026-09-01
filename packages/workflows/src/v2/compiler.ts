import { createHash } from "node:crypto";
import type { RunSpec, StepSpec } from "@forge/execution";
import type {
  DurableWorkflowDefinition,
  WorkflowRunContext,
  WorkflowStepDefinition,
} from "./types.js";

export class WorkflowCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCompileError";
  }
}

const DEFAULT_RETRY = { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 };
const DEFAULT_TIMEOUT_MS = 60_000;

export function compileWorkflowRun(
  definition: DurableWorkflowDefinition,
  input: unknown,
  context: WorkflowRunContext,
): RunSpec {
  validateWorkflowInput(definition, input);
  assertAcyclic(definition.steps);

  const steps: StepSpec[] = definition.steps.map((step) => ({
    id: step.id,
    kind: step.kind,
    dependsOn: [...step.dependsOn],
    input: mergeStepInput(step, input),
    workspaceBindingId: step.workspaceBindingId,
    idempotencyKey: step.idempotencyKey,
    retry: step.retry ?? DEFAULT_RETRY,
    timeoutMs: step.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }));

  return {
    id: context.instanceId,
    requestedBy: context.requestedBy,
    actingSubject: context.actingSubject,
    objective: context.objective ?? `workflow:${definition.id}`,
    steps,
    budgetAccountId: context.budgetAccountId,
    policyContext: {
      workflowId: definition.id,
      workflowVersion: definition.version,
      ...(context.policyContext ?? {}),
    },
    correlationId: `workflow-instance:${definition.id}:${context.instanceNumber}`,
  };
}

export function hashWorkflowDefinition(
  definition: DurableWorkflowDefinition,
): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

function mergeStepInput(
  step: WorkflowStepDefinition,
  workflowInput: unknown,
): unknown {
  const base =
    workflowInput && typeof workflowInput === "object" && !Array.isArray(workflowInput)
      ? (workflowInput as Record<string, unknown>)
      : {};
  return { ...base, ...step.input };
}

function validateWorkflowInput(
  definition: DurableWorkflowDefinition,
  input: unknown,
): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkflowCompileError("workflow input must be an object");
  }

  const schema = definition.inputSchema;
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};

  for (const key of required) {
    if (!(key in (input as Record<string, unknown>))) {
      throw new WorkflowCompileError(`missing required input: ${key}`);
    }
  }

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const property = properties[key] as { type?: string } | undefined;
    if (!property?.type) {
      continue;
    }
    if (property.type === "string" && typeof value !== "string") {
      throw new WorkflowCompileError(`invalid input type for ${key}`);
    }
    if (property.type === "number" && typeof value !== "number") {
      throw new WorkflowCompileError(`invalid input type for ${key}`);
    }
    if (property.type === "boolean" && typeof value !== "boolean") {
      throw new WorkflowCompileError(`invalid input type for ${key}`);
    }
  }
}

function assertAcyclic(steps: WorkflowStepDefinition[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) {
        throw new WorkflowCompileError(`unknown dependency: ${dependency}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (stepId: string): void => {
    if (visited.has(stepId)) {
      return;
    }
    if (visiting.has(stepId)) {
      throw new WorkflowCompileError("workflow contains a cyclic dependency");
    }
    visiting.add(stepId);
    const step = byId.get(stepId);
    if (!step) {
      throw new WorkflowCompileError(`unknown step: ${stepId}`);
    }
    for (const dependency of step.dependsOn) {
      visit(dependency);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  };

  for (const step of steps) {
    visit(step.id);
  }
}
