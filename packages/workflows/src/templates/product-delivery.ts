import type {
  DurableWorkflowDefinition,
  WorkflowStepDefinition,
} from "../v2/types.js";

export const PRODUCT_DELIVERY_STREAM_IDS = [
  "frontend",
  "backend",
  "docs",
] as const;

export type ProductDeliveryStreamId =
  (typeof PRODUCT_DELIVERY_STREAM_IDS)[number];

export interface DeliveryProjectAssignmentRef {
  employeeId: string;
  responsibility: string;
  workItemId: string;
  workspaceBindingId?: string;
  streamId?: ProductDeliveryStreamId;
}

export interface DeliveryProjectRef {
  projectId: string;
  assignments: DeliveryProjectAssignmentRef[];
}

export interface ProductDeliveryWorkflowInput {
  projectId: string;
  deliveryProject?: DeliveryProjectRef;
  approvedScopeRef?: string;
  technicalGateRef?: string;
  workspaceBindingIds?: Partial<Record<ProductDeliveryStreamId, string>>;
  assignmentRefs?: Partial<Record<ProductDeliveryStreamId, string>>;
  workItemRefs?: Partial<Record<ProductDeliveryStreamId, string>>;
}

const PRODUCT_DELIVERY_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["projectId"],
  additionalProperties: true,
  properties: {
    projectId: { type: "string", minLength: 1 },
  },
};

const HANDOFF_OUTPUT_CONTRACT: Record<string, unknown> = {
  type: "object",
  required: [
    "conclusion",
    "recommendedActions",
    "completedScope",
    "incompleteScope",
    "artifactRefs",
    "evidenceIds",
    "assumptions",
    "uncertainties",
    "risks",
    "downstreamQuestions",
    "version",
    "from",
    "to",
    "timestamp",
  ],
  additionalProperties: true,
  properties: {
    conclusion: { type: "string", minLength: 1 },
    recommendedActions: stringArray(),
    completedScope: stringArray(),
    incompleteScope: stringArray(),
    artifactRefs: stringArray(1),
    evidenceIds: stringArray(1),
    assumptions: stringArray(),
    uncertainties: stringArray(),
    risks: stringArray(),
    downstreamQuestions: stringArray(),
    version: {
      anyOf: [
        { type: "string", minLength: 1 },
        { type: "number", minimum: 1 },
      ],
    },
    from: { type: "string", minLength: 1 },
    to: { type: "string", minLength: 1 },
    timestamp: { type: "string", minLength: 1 },
  },
};

export function createProductDeliveryWorkflow(
  input: ProductDeliveryWorkflowInput,
): DurableWorkflowDefinition {
  if (
    input.deliveryProject &&
    input.deliveryProject.projectId !== input.projectId
  ) {
    throw new Error("delivery project mismatch");
  }

  const implementationSteps = createImplementationSteps(input);
  assertIndependentWriteWorkspaces(implementationSteps);

  return {
    id: "forge.company.product-delivery",
    version: 1,
    inputSchema: PRODUCT_DELIVERY_INPUT_SCHEMA,
    steps: [
      handoffStep("design", "product-delivery.design", [], input),
      ...implementationSteps,
      handoffStep(
        "integrated-validation",
        "product-delivery.integrated-validation",
        [...PRODUCT_DELIVERY_STREAM_IDS],
        input,
      ),
      handoffStep(
        "release-gate",
        "product-delivery.release-gate",
        ["integrated-validation"],
        input,
      ),
      handoffStep(
        "review",
        "product-delivery.review",
        ["release-gate"],
        input,
      ),
    ],
    triggers: [{ kind: "manual" }],
    concurrency: { maxRuns: 1, keyExpression: "$.projectId" },
  };
}

function createImplementationSteps(
  input: ProductDeliveryWorkflowInput,
): WorkflowStepDefinition[] {
  const implementationAssignments =
    input.deliveryProject?.assignments.filter(
      (assignment) => assignment.responsibility === "implementation",
    ) ?? [];

  return PRODUCT_DELIVERY_STREAM_IDS.map((id) => {
    const requestedWorkspaceBindingId = normalizeOptional(
      input.workspaceBindingIds?.[id],
    );
    const assignment =
      implementationAssignments.find((candidate) => candidate.streamId === id) ??
      (requestedWorkspaceBindingId
        ? implementationAssignments.find(
            (candidate) =>
              normalizeOptional(candidate.workspaceBindingId) ===
              requestedWorkspaceBindingId,
          )
        : undefined);
    const workspaceBindingId =
      requestedWorkspaceBindingId ??
      normalizeOptional(assignment?.workspaceBindingId);
    const workItemRef = input.workItemRefs?.[id] ?? assignment?.workItemId;
    const assignmentRef =
      input.assignmentRefs?.[id] ?? assignment?.employeeId;

    return {
      id,
      kind: `product-delivery.${id}`,
      dependsOn: ["design"],
      input: {
        projectId: input.projectId,
        ...(assignmentRef ? { assignmentRef } : {}),
        ...(workItemRef ? { workItemRef } : {}),
        workspaceAccess: "write",
        outputContract: HANDOFF_OUTPUT_CONTRACT,
      },
      ...(workspaceBindingId ? { workspaceBindingId } : {}),
    };
  });
}

function handoffStep(
  id: string,
  kind: string,
  dependsOn: string[],
  input: ProductDeliveryWorkflowInput,
): WorkflowStepDefinition {
  return {
    id,
    kind,
    dependsOn,
    input: {
      projectId: input.projectId,
      ...(id === "design" && input.approvedScopeRef
        ? { approvedScopeRef: input.approvedScopeRef }
        : {}),
      ...(id === "design" && input.technicalGateRef
        ? { technicalGateRef: input.technicalGateRef }
        : {}),
      outputContract: HANDOFF_OUTPUT_CONTRACT,
    },
  };
}

function assertIndependentWriteWorkspaces(
  steps: WorkflowStepDefinition[],
): void {
  const workspaceBindingIds = steps.flatMap((step) =>
    normalizeOptional(step.workspaceBindingId)
      ? [normalizeOptional(step.workspaceBindingId)!]
      : [],
  );
  if (new Set(workspaceBindingIds).size !== workspaceBindingIds.length) {
    throw new Error("implementation workspace binding conflict");
  }
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function stringArray(minItems = 0): Record<string, unknown> {
  return {
    type: "array",
    minItems,
    items: { type: "string", minLength: 1 },
  };
}
