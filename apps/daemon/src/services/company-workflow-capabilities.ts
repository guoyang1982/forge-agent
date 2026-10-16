import type { StepExecutorRegistry } from "@forge/execution";
import { COMPANY_RESEARCH_WORKFLOW_ID, type CompanyWorkflowCapability } from "@forge/protocol";
import { createProductDeliveryWorkflow, createRequirementResearchWorkflow } from "@forge/workflows";

export interface CompanyWorkflowCapabilityOptions {
  /**
   * Composition declares that dispatch, step governance, executors and gate resume are wired
   * for requirement-research. Registering executors alone never enables orchestration.
   */
  researchOrchestrationReady?: boolean;
}

/** Inspect actual registrations; only requirement-research can become runnable. */
export function getCompanyWorkflowCapabilities(
  registry?: Pick<StepExecutorRegistry, "get">,
  options: CompanyWorkflowCapabilityOptions = {},
): CompanyWorkflowCapability[] {
  const definitions = [
    createRequirementResearchWorkflow({ briefId: "capability-probe" }),
    createProductDeliveryWorkflow({ projectId: "capability-probe" }),
  ];
  return definitions.map((definition) => {
    const missingExecutorKinds = [...new Set(definition.steps.map((step) => step.kind))]
      .filter((kind) => !registry?.get(kind));
    const missing = missingExecutorKinds.length ? ["missing_runtime_executors"] : [];
    if (definition.id === COMPANY_RESEARCH_WORKFLOW_ID && options.researchOrchestrationReady) {
      return {
        workflowId: definition.id,
        templateVersion: definition.version,
        runnable: missing.length === 0,
        missingExecutorKinds,
        blockers: missing,
      };
    }
    return {
      workflowId: definition.id,
      templateVersion: definition.version,
      runnable: false,
      missingExecutorKinds,
      blockers: [
        ...missing,
        ...(definition.id === COMPANY_RESEARCH_WORKFLOW_ID ? [] : ["deferred_until_feasibility_milestone"]),
        "missing_company_workflow_dispatch",
        "missing_step_scoped_governance",
        "missing_durable_handoff_and_gate_integration",
      ],
    };
  });
}
