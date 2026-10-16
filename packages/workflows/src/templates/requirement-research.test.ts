import { describe, expect, it } from "vitest";
import {
  RESEARCH_BRANCH_TIMEOUT_MS,
  createRequirementResearchWorkflow,
  type ResearchBranchId,
  type ResearchWorkflowInput,
} from "./requirement-research.js";

const BRANCH_IDS: ResearchBranchId[] = [
  "user-research",
  "market-research",
  "code-data-research",
  "risk-research",
];

function researchTemplateInput(): ResearchWorkflowInput {
  return {
    briefId: "brief-1",
    agentProfileRefs: {
      "user-research": { profileId: "user", profileVersionId: "user-v1" },
      "market-research": { profileId: "market", profileVersionId: "market-v1" },
      "code-data-research": { profileId: "code", profileVersionId: "code-v1" },
      "risk-research": { profileId: "risk", profileVersionId: "risk-v1" },
    },
  };
}

describe("createRequirementResearchWorkflow", () => {
  it("creates four parallel research branches followed by synthesis and gate", () => {
    const workflow = createRequirementResearchWorkflow(researchTemplateInput());

    expect(
      workflow.steps
        .filter((step) => step.dependsOn.length === 0)
        .map((step) => step.id)
        .sort(),
    ).toEqual([...BRANCH_IDS].sort());
    expect(workflow.steps.find((step) => step.id === "synthesis")?.dependsOn)
      .toEqual(BRANCH_IDS);
    expect(workflow.steps.find((step) => step.id === "research-gate")?.dependsOn)
      .toEqual(["synthesis"]);
  });

  it("requires a Chinese conclusion plus claims, EvidenceRefs, and unknowns from every research branch", () => {
    const workflow = createRequirementResearchWorkflow(researchTemplateInput());

    for (const branchId of BRANCH_IDS) {
      const contract = workflow.steps.find((step) => step.id === branchId)
        ?.input.outputContract;
      expect(contract).toMatchObject({
        type: "object",
        required: ["conclusionZh", "claims", "evidenceRefs", "unknowns"],
      });
      expect(contract).toMatchObject({
        properties: {
          conclusionZh: { type: "string", minLength: 40 },
        },
      });
    }
  });

  it("binds each branch to its configured independent workspace", () => {
    const workspaceBindingIds = Object.fromEntries(
      BRANCH_IDS.map((id) => [id, `workspace:${id}`]),
    );
    const workflow = createRequirementResearchWorkflow({
      ...researchTemplateInput(),
      workspaceBindingIds,
    });

    for (const branchId of BRANCH_IDS) {
      const step = workflow.steps.find((candidate) => candidate.id === branchId);
      expect(step?.workspaceBindingId).toBe(`workspace:${branchId}`);
      expect(step?.input.workspaceAccess).toBe("read_only");
    }
  });

  it("returns the versioned manual workflow contract", () => {
    const workflow = createRequirementResearchWorkflow(researchTemplateInput());

    expect(workflow).toMatchObject({
      id: "forge.company.requirement-research",
      version: 2,
      triggers: [{ kind: "manual" }],
      concurrency: { maxRuns: 4, keyExpression: "$.briefId" },
    });
    expect(workflow.inputSchema.required).toContain("briefId");
    for (const branchId of BRANCH_IDS) {
      expect(workflow.steps.find((step) => step.id === branchId)?.timeoutMs)
        .toBe(RESEARCH_BRANCH_TIMEOUT_MS);
    }
  });
});
