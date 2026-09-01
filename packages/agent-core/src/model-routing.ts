import type { AgentCapabilitySnapshot } from "@forge/agent-profile";

export interface ModelCandidate {
  modelId: string;
  capabilities: string[];
  costMinor: bigint;
  available: boolean;
  authorized: boolean;
}

export interface ModelRouteInput {
  snapshot: AgentCapabilitySnapshot;
  requiredCapabilities: string[];
  remainingMinor: bigint;
  routingPolicyVersion: string;
  candidates: ModelCandidate[];
  taskClassification?: string;
}

export interface ModelRoutingDecision {
  modelId: string;
  profileVersionId: string;
  routingPolicyVersion: string;
  estimatedCostMinor: bigint;
  requiredCapabilities: string[];
  reason: string;
}

export class ModelRouter {
  select(input: ModelRouteInput): ModelRoutingDecision {
    const eligible = input.candidates
      .filter((candidate) => candidate.available && candidate.authorized)
      .filter((candidate) =>
        input.requiredCapabilities.every((capability) =>
          candidate.capabilities.includes(capability),
        ),
      )
      .filter((candidate) => candidate.costMinor <= input.remainingMinor)
      .sort((left, right) => {
        if (left.costMinor === right.costMinor) {
          return left.modelId.localeCompare(right.modelId);
        }
        return left.costMinor < right.costMinor ? -1 : 1;
      });

    if (eligible.length === 0) {
      throw new ModelRoutingError("no eligible model within budget and capability constraints");
    }

    const selected = eligible[0]!;
    return {
      modelId: selected.modelId,
      profileVersionId: input.snapshot.profileVersionId,
      routingPolicyVersion: input.routingPolicyVersion,
      estimatedCostMinor: selected.costMinor,
      requiredCapabilities: [...input.requiredCapabilities],
      reason: `selected ${selected.modelId} within remaining budget (${input.remainingMinor} minor)`,
    };
  }
}

export class ModelRoutingError extends Error {
  readonly code = "MODEL_ROUTING_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

export function buildModelRouteTrace(decision: ModelRoutingDecision): Record<string, unknown> {
  return {
    type: "model.routing.decision",
    modelId: decision.modelId,
    profileVersionId: decision.profileVersionId,
    routingPolicyVersion: decision.routingPolicyVersion,
    estimatedCostMinor: Number(decision.estimatedCostMinor),
    requiredCapabilities: decision.requiredCapabilities,
    reason: decision.reason,
  };
}
