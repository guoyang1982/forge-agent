import type {
  DurableWorkflowDefinition,
  WorkflowStepDefinition,
} from "../v2/types.js";

export const RESEARCH_BRANCH_IDS = [
  "user-research",
  "market-research",
  "code-data-research",
  "risk-research",
] as const;

export type ResearchBranchId = (typeof RESEARCH_BRANCH_IDS)[number];

export interface AgentProfileRef {
  profileId: string;
  profileVersionId: string;
}

export interface ResearchBriefInput {
  id: string;
  version: number;
  normalizedProblem: string;
  targetUser: string;
  expectedOutcome: string;
  constraints: string[];
  researchQuestions: string[];
  stopConditions: string[];
}

export interface ResearchWorkflowInput {
  briefId: string;
  brief?: ResearchBriefInput;
  agentProfileRefs?: Partial<Record<ResearchBranchId, AgentProfileRef>>;
  workspaceBindingIds?: Partial<Record<ResearchBranchId, string>>;
}

const RESEARCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["briefId"],
  additionalProperties: true,
  properties: {
    briefId: { type: "string", minLength: 1 },
  },
};

const RESEARCH_OUTPUT_CONTRACT: Record<string, unknown> = {
  type: "object",
  required: ["conclusionZh", "claims", "evidenceRefs", "unknowns"],
  additionalProperties: false,
  properties: {
    conclusionZh: {
      type: "string",
      minLength: 40,
      description: "Chinese decision summary for operators: judgment first, then key reasons and gaps.",
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        required: ["text", "classification", "evidenceRefs"],
        properties: {
          text: { type: "string" },
          classification: {
            enum: ["fact", "inference", "hypothesis", "unknown"],
          },
          evidenceRefs: {
            type: "array",
            items: { $ref: "#/$defs/EvidenceRef" },
          },
        },
      },
    },
    evidenceRefs: {
      type: "array",
      items: { $ref: "#/$defs/EvidenceRef" },
    },
    unknowns: {
      type: "array",
      items: { type: "string" },
    },
  },
  $defs: {
    EvidenceRef: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 },
        source: { type: "string" },
        version: { type: ["string", "number"] },
      },
    },
  },
};

/** Branch agents need web/code inspection time; 60s default aborts mid-research. */
export const RESEARCH_BRANCH_TIMEOUT_MS = 15 * 60 * 1000;
/** Includes the formal-report writing pass after the four branches. */
export const RESEARCH_SYNTHESIS_TIMEOUT_MS = 8 * 60 * 1000;
export const RESEARCH_GATE_TIMEOUT_MS = 60 * 1000;

export function createRequirementResearchWorkflow(
  input: ResearchWorkflowInput,
): DurableWorkflowDefinition {
  return {
    id: "forge.company.requirement-research",
    version: 2,
    inputSchema: RESEARCH_INPUT_SCHEMA,
    steps: [
      ...createResearchSteps(input),
      {
        id: "synthesis",
        kind: "requirement-research.synthesis",
        dependsOn: [...RESEARCH_BRANCH_IDS],
        timeoutMs: RESEARCH_SYNTHESIS_TIMEOUT_MS,
        input: {
          briefId: input.briefId,
          sourceStepIds: [...RESEARCH_BRANCH_IDS],
        },
      },
      {
        id: "research-gate",
        kind: "requirement-research.gate",
        dependsOn: ["synthesis"],
        timeoutMs: RESEARCH_GATE_TIMEOUT_MS,
        input: {
          briefId: input.briefId,
          synthesisStepId: "synthesis",
        },
      },
    ],
    triggers: [{ kind: "manual" }],
    concurrency: { maxRuns: 4, keyExpression: "$.briefId" },
  };
}

function createResearchSteps(
  input: ResearchWorkflowInput,
): WorkflowStepDefinition[] {
  return RESEARCH_BRANCH_IDS.map((id) => {
    const agentProfileRef = input.agentProfileRefs?.[id];
    const workspaceBindingId = input.workspaceBindingIds?.[id];

    return {
      id,
      kind: `requirement-research.${id}`,
      dependsOn: [],
      timeoutMs: RESEARCH_BRANCH_TIMEOUT_MS,
      retry: { maxAttempts: 2, backoffMs: 2_000, maxBackoffMs: 10_000 },
      input: {
        briefId: input.briefId,
        ...(input.brief ? { brief: input.brief } : {}),
        ...(agentProfileRef ? { agentProfileRef } : {}),
        workspaceAccess: "read_only",
        outputContract: RESEARCH_OUTPUT_CONTRACT,
      },
      ...(workspaceBindingId ? { workspaceBindingId } : {}),
    };
  });
}
