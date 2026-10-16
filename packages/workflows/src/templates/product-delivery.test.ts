import { describe, expect, it } from "vitest";
import {
  createProductDeliveryWorkflow,
  type ProductDeliveryWorkflowInput,
} from "./product-delivery.js";

function deliveryWorkflowInput(): ProductDeliveryWorkflowInput {
  return {
    projectId: "project-1",
    workspaceBindingIds: {
      frontend: "workspace:frontend",
      backend: "workspace:backend",
      docs: "workspace:docs",
    },
    workItemRefs: {
      frontend: "work-item:frontend",
      backend: "work-item:backend",
      docs: "work-item:docs",
    },
  };
}

describe("createProductDeliveryWorkflow", () => {
  it("passes approved scope and technical gate refs to design", () => {
    const workflow = createProductDeliveryWorkflow({
      ...deliveryWorkflowInput(),
      approvedScopeRef: "scope-gate:v1",
      technicalGateRef: "technical-gate:v1",
    });

    expect(workflow.steps.find((step) => step.id === "design")?.input)
      .toMatchObject({
        approvedScopeRef: "scope-gate:v1",
        technicalGateRef: "technical-gate:v1",
      });
  });

  it("rejects a delivery project for another project", () => {
    expect(() =>
      createProductDeliveryWorkflow({
        ...deliveryWorkflowInput(),
        deliveryProject: {
          projectId: "project-2",
          assignments: [],
        },
      }),
    ).toThrow("delivery project mismatch");
  });

  it("matches delivery assignments by workspace instead of array position", () => {
    const workflow = createProductDeliveryWorkflow({
      ...deliveryWorkflowInput(),
      deliveryProject: {
        projectId: "project-1",
        assignments: [
          {
            employeeId: "employee:backend",
            responsibility: "implementation",
            workItemId: "assigned-work-item:backend",
            workspaceBindingId: "workspace:backend",
          },
          {
            employeeId: "employee:frontend",
            responsibility: "implementation",
            workItemId: "assigned-work-item:frontend",
            workspaceBindingId: "workspace:frontend",
          },
        ],
      },
      workItemRefs: undefined,
    });

    expect(workflow.steps.find((step) => step.id === "backend")?.input)
      .toMatchObject({
        assignmentRef: "employee:backend",
        workItemRef: "assigned-work-item:backend",
      });
    expect(workflow.steps.find((step) => step.id === "frontend")?.input)
      .toMatchObject({
        assignmentRef: "employee:frontend",
        workItemRef: "assigned-work-item:frontend",
      });
    expect(workflow.steps.find((step) => step.id === "docs")?.input)
      .not.toHaveProperty("assignmentRef");
  });

  it("joins implementation streams before integrated validation", () => {
    const workflow = createProductDeliveryWorkflow(deliveryWorkflowInput());
    const integratedValidation = workflow.steps.find(
      (step) => step.id === "integrated-validation",
    );

    expect(integratedValidation?.dependsOn.sort()).toEqual([
      "backend",
      "docs",
      "frontend",
    ]);
    expect(workflow.steps.find((step) => step.id === "design")?.dependsOn)
      .toEqual([]);
    for (const streamId of ["frontend", "backend", "docs"]) {
      expect(workflow.steps.find((step) => step.id === streamId)?.dependsOn)
        .toEqual(["design"]);
    }
    expect(workflow.steps.find((step) => step.id === "release-gate")?.dependsOn)
      .toEqual(["integrated-validation"]);
    expect(workflow.steps.find((step) => step.id === "review")?.dependsOn)
      .toEqual(["release-gate"]);
  });

  it("requires artifact evidence and uncertainties in each handoff", () => {
    const workflow = createProductDeliveryWorkflow(deliveryWorkflowInput());

    for (const step of workflow.steps) {
      expect(step.input.outputContract).toMatchObject({
        type: "object",
        required: expect.arrayContaining([
          "conclusion",
          "completedScope",
          "incompleteScope",
          "artifactRefs",
          "evidenceIds",
          "uncertainties",
          "risks",
          "downstreamQuestions",
          "version",
          "from",
          "to",
          "timestamp",
        ]),
      });
    }
  });

  it("binds independent implementation streams for write access", () => {
    const workflow = createProductDeliveryWorkflow(deliveryWorkflowInput());

    for (const streamId of ["frontend", "backend", "docs"] as const) {
      const step = workflow.steps.find((candidate) => candidate.id === streamId);
      expect(step?.workspaceBindingId).toBe(`workspace:${streamId}`);
      expect(step?.input).toMatchObject({
        projectId: "project-1",
        workItemRef: `work-item:${streamId}`,
        workspaceAccess: "write",
      });
    }
  });

  it("rejects parallel writers bound to the same workspace", () => {
    expect(() =>
      createProductDeliveryWorkflow({
        ...deliveryWorkflowInput(),
        workspaceBindingIds: {
          frontend: "workspace:shared",
          backend: "workspace:shared",
        },
      }),
    ).toThrow("implementation workspace binding conflict");
  });

  it("normalizes workspace bindings before conflict comparison", () => {
    expect(() =>
      createProductDeliveryWorkflow({
        ...deliveryWorkflowInput(),
        workspaceBindingIds: {
          frontend: " workspace:shared ",
          backend: "workspace:shared",
        },
      }),
    ).toThrow("implementation workspace binding conflict");
  });

  it("returns the versioned manual project workflow contract", () => {
    const workflow = createProductDeliveryWorkflow(deliveryWorkflowInput());

    expect(workflow).toMatchObject({
      id: "forge.company.product-delivery",
      version: 1,
      triggers: [{ kind: "manual" }],
      concurrency: { maxRuns: 1, keyExpression: "$.projectId" },
    });
    expect(workflow.inputSchema.required).toContain("projectId");
  });
});
