import { describe, expect, it } from "vitest";
import { StepExecutorRegistry } from "@forge/execution";
import { getCompanyWorkflowCapabilities } from "./company-workflow-capabilities.js";

describe("company workflow runtime capabilities", () => {
  it("reports unavailable research and product executors without executing anything", () => {
    const capabilities = getCompanyWorkflowCapabilities(new StepExecutorRegistry());
    expect(capabilities).toHaveLength(2);
    expect(capabilities[0]).toMatchObject({
      workflowId: "forge.company.requirement-research",
      runnable: false,
      missingExecutorKinds: [
        "requirement-research.user-research", "requirement-research.market-research",
        "requirement-research.code-data-research", "requirement-research.risk-research",
        "requirement-research.synthesis", "requirement-research.gate",
      ],
    });
    expect(capabilities[1]!.missingExecutorKinds).toContain("product-delivery.release-gate");
    expect(capabilities.every((entry) => !entry.runnable)).toBe(true);
  });

  it("reflects actual registrations but keeps missing orchestration disabled", () => {
    const registry = new StepExecutorRegistry();
    for (const capability of getCompanyWorkflowCapabilities()) {
      for (const kind of capability.missingExecutorKinds) {
        registry.register({ kind, execute: async () => { throw new Error("must not execute"); } });
      }
    }
    for (const capability of getCompanyWorkflowCapabilities(registry)) {
      expect(capability.missingExecutorKinds).toEqual([]);
      expect(capability.runnable).toBe(false);
      expect(capability.blockers).not.toContain("missing_runtime_executors");
      expect(capability.blockers).toContain("missing_step_scoped_governance");
    }
  });

  function fullRegistry() {
    const registry = new StepExecutorRegistry();
    for (const capability of getCompanyWorkflowCapabilities()) {
      for (const kind of capability.missingExecutorKinds) {
        registry.register({ kind, execute: async () => { throw new Error("must not execute"); } });
      }
    }
    return registry;
  }

  it("marks only requirement-research runnable when research orchestration is ready", () => {
    const caps = getCompanyWorkflowCapabilities(fullRegistry(), { researchOrchestrationReady: true });
    expect(caps.find((c) => c.workflowId.includes("requirement-research"))).toMatchObject({
      runnable: true,
      blockers: [],
      missingExecutorKinds: [],
    });
    const delivery = caps.find((c) => c.workflowId.includes("product-delivery"))!;
    expect(delivery.runnable).toBe(false);
    expect(delivery.blockers).toContain("deferred_until_feasibility_milestone");
  });

  it("keeps research blocked when executors are missing even if orchestration is ready", () => {
    const caps = getCompanyWorkflowCapabilities(new StepExecutorRegistry(), { researchOrchestrationReady: true });
    const research = caps.find((c) => c.workflowId.includes("requirement-research"))!;
    expect(research.runnable).toBe(false);
    expect(research.blockers).toContain("missing_runtime_executors");
  });

  it("keeps research blocked when orchestration is not declared ready", () => {
    const caps = getCompanyWorkflowCapabilities(fullRegistry());
    expect(caps.every((c) => !c.runnable)).toBe(true);
  });
});
