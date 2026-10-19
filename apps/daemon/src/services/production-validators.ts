import {
  ValidatorRegistry,
  type ValidationInput,
  type Validator,
} from "@forge/evidence";

export function createProductionValidatorRegistry(): ValidatorRegistry {
  const registry = new ValidatorRegistry();
  registry.register(forgeAgentOutputValidator());
  registry.register(companyResearchStepOutputValidator());
  registry.register(automationWorkflowDefinitionValidator());
  registry.register(companyWorkflowDefinitionValidator());
  return registry;
}

const COMPANY_RESEARCH_BRANCH_KINDS = [
  "requirement-research.user-research",
  "requirement-research.market-research",
  "requirement-research.code-data-research",
  "requirement-research.risk-research",
];

/**
 * Fail-closed publish check for company workflow definitions. Only the
 * requirement-research template shape (read-only branches, synthesis, gate and
 * a single manual trigger) is accepted in this milestone.
 */
export function companyWorkflowDefinitionValidator(): Validator {
  return {
    id: "company-workflow-definition",
    layer: "process",
    appliesTo: (input) =>
      input.context?.validationTarget === "company.workflow.definition",
    validate: async (input) => {
      const safe = isSafeResearchDefinition(input.context?.definition);
      return {
        status: safe ? "passed" : "failed",
        layer: "process",
        severity: "blocking",
        evidenceIds: input.evidenceIds,
        summary: safe
          ? "company research workflow contains only read-only research steps, synthesis and gate"
          : "company workflow definition is not eligible for governed research execution",
        details: {
          assetId: input.context?.assetId,
          assetVersionId: input.context?.assetVersionId,
          subjectKind: input.context?.subjectKind,
          subjectId: input.context?.subjectId,
          action: input.context?.action,
          policyVersionId: input.context?.policyVersionId,
          validationType: "publish",
        },
      };
    },
  };
}

function isSafeResearchDefinition(value: unknown): boolean {
  const definition = readRecord(value);
  if (!definition || definition.id !== "forge.company.requirement-research") return false;
  const steps = Array.isArray(definition.steps) ? definition.steps.map(readRecord) : [];
  const triggers = Array.isArray(definition.triggers) ? definition.triggers.map(readRecord) : [];
  if (steps.length !== COMPANY_RESEARCH_BRANCH_KINDS.length + 2) return false;
  if (steps.some((step) => !step)) return false;
  if (triggers.length !== 1 || triggers[0]?.kind !== "manual") return false;
  const kinds = steps.map((step) => step?.kind);
  const expected = [
    ...COMPANY_RESEARCH_BRANCH_KINDS,
    "requirement-research.synthesis",
    "requirement-research.gate",
  ];
  if (expected.some((kind) => !kinds.includes(kind))) return false;
  return steps.every((step) => {
    if (!step || !COMPANY_RESEARCH_BRANCH_KINDS.includes(String(step.kind))) return true;
    return readRecord(step.input)?.workspaceAccess === "read_only";
  });
}

export function automationWorkflowDefinitionValidator(): Validator {
  return {
    id: "automation-workflow-definition",
    layer: "process",
    appliesTo: (input) =>
      input.context?.validationTarget === "automation.workflow.definition",
    validate: async (input) => {
      const definition = readRecord(input.context?.definition);
      const steps = Array.isArray(definition?.steps) ? definition.steps : [];
      const triggers = Array.isArray(definition?.triggers) ? definition.triggers : [];
      const onlyStep = readRecord(steps[0]);
      const safe =
        steps.length === 1 &&
        onlyStep?.kind === "forge.agent" &&
        triggers.length === 1;
      return {
        status: safe ? "passed" : "failed",
        layer: "process",
        severity: "blocking",
        evidenceIds: input.evidenceIds,
        summary: safe
          ? "automation workflow contains one governed Forge agent step and one trigger"
          : "automation workflow definition is not eligible for governed execution",
        details: {
          assetId: input.context?.assetId,
          assetVersionId: input.context?.assetVersionId,
          subjectKind: input.context?.subjectKind,
          subjectId: input.context?.subjectId,
          action: input.context?.action,
          policyVersionId: input.context?.policyVersionId,
          validationType: "publish",
        },
      };
    },
  };
}

export function forgeAgentOutputValidator(): Validator {
  return {
    id: "forge-agent-output-reference",
    layer: "result",
    appliesTo: (input) => input.context?.stepKind === "forge.agent",
    validate: async (input) => validateForgeAgentOutput(input),
  };
}

/**
 * Result coverage for governed requirement-research steps: a step may only be
 * accepted once it has produced a durable output reference. Gate steps resume
 * with a persisted decision output, so the same check applies.
 */
export function companyResearchStepOutputValidator(): Validator {
  return {
    id: "company-research-step-output-reference",
    layer: "result",
    appliesTo: (input) =>
      typeof input.context?.stepKind === "string" &&
      input.context.stepKind.startsWith("requirement-research."),
    validate: async (input) => {
      const outputRef = input.context?.outputRef;
      const passed = typeof outputRef === "string" && outputRef.trim().length > 0;
      return {
        status: passed ? "passed" as const : "failed" as const,
        layer: "result" as const,
        severity: "blocking" as const,
        evidenceIds: input.evidenceIds,
        summary: passed
          ? "requirement-research step output reference present"
          : "requirement-research step output reference missing",
      };
    },
  };
}

function validateForgeAgentOutput(input: ValidationInput) {
  const outputRef = input.context?.outputRef;
  const passed = typeof outputRef === "string" && outputRef.trim().length > 0;
  return {
    status: passed ? "passed" as const : "failed" as const,
    layer: "result" as const,
    severity: "blocking" as const,
    evidenceIds: input.evidenceIds,
    summary: passed
      ? "durable Forge agent output reference present"
      : "durable Forge agent output reference missing",
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
