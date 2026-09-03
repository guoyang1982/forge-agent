import {
  ValidatorRegistry,
  type ValidationInput,
  type Validator,
} from "@forge/evidence";

export function createProductionValidatorRegistry(): ValidatorRegistry {
  const registry = new ValidatorRegistry();
  registry.register(forgeAgentOutputValidator());
  registry.register(automationWorkflowDefinitionValidator());
  return registry;
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
