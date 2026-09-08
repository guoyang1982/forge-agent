import { describe, expect, it } from "vitest";
import {
  WorkflowCompileError,
  compileWorkflowRun,
} from "./compiler.js";
import type { DurableWorkflowDefinition, WorkflowRunContext } from "./types.js";

const definition: DurableWorkflowDefinition = {
  id: "wf-1",
  version: 1,
  inputSchema: {
    type: "object",
    required: ["topic"],
    properties: { topic: { type: "string" } },
  },
  steps: [
    { id: "research", kind: "research", dependsOn: [], input: {} },
    { id: "draft", kind: "draft", dependsOn: ["research"], input: {} },
    { id: "approve", kind: "approve", dependsOn: ["draft"], input: {} },
  ],
  triggers: [{ kind: "manual" }],
  concurrency: { maxRuns: 1 },
};

const context: WorkflowRunContext = {
  workflowId: "wf-1",
  instanceId: "instance-1",
  instanceNumber: 1,
  requestedBy: { kind: "human", id: "local" },
  actingSubject: { kind: "human", id: "local" },
};

describe("compileWorkflowRun", () => {
  it("compiles a workflow definition into a RunSpec", () => {
    const run = compileWorkflowRun(definition, { topic: "launch" }, context);
    expect(run.steps.map((step) => step.id)).toEqual([
      "research",
      "draft",
      "approve",
    ]);
    expect(run.correlationId).toBe("workflow-instance:wf-1:1");
    expect(run.id).toBe("instance-1");
  });

  it("rejects invalid workflow input", () => {
    expect(() => compileWorkflowRun(definition, {}, context)).toThrow(
      WorkflowCompileError,
    );
    expect(() => compileWorkflowRun(definition, { topic: 42 }, context)).toThrow(
      /invalid input type/,
    );
  });

  it("rejects cyclic dependencies", () => {
    const cyclic: DurableWorkflowDefinition = {
      ...definition,
      steps: [
        { id: "a", kind: "a", dependsOn: ["b"], input: {} },
        { id: "b", kind: "b", dependsOn: ["a"], input: {} },
      ],
    };
    expect(() =>
      compileWorkflowRun(cyclic, { topic: "launch" }, context),
    ).toThrow(/cyclic dependency/);
  });

  it("rejects unknown dependencies", () => {
    const invalid: DurableWorkflowDefinition = {
      ...definition,
      steps: [{ id: "solo", kind: "solo", dependsOn: ["missing"], input: {} }],
    };
    expect(() =>
      compileWorkflowRun(invalid, { topic: "launch" }, context),
    ).toThrow(/unknown dependency/);
  });

  it("rejects workflow definitions without a published version number", () => {
    expect(() =>
      compileWorkflowRun({ ...definition, version: 0 }, { topic: "launch" }, context),
    ).toThrow(/published workflow version is required/);
  });
});
