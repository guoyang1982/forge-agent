import { describe, expect, it } from "vitest";
import { validateHandoff, type Handoff } from "./handoff.js";

function validHandoff(): Handoff {
  return {
    conclusion: "Implementation is ready for integrated validation.",
    recommendedActions: ["Run the integration suite."],
    completedScope: ["Implemented the approved API."],
    incompleteScope: [],
    artifactRefs: ["artifact:api-build"],
    evidenceIds: ["evidence:api-tests"],
    assumptions: [],
    uncertainties: [],
    risks: [],
    downstreamQuestions: ["Is the release environment available?"],
    version: 1,
    from: "employee:backend",
    to: "employee:validation",
    timestamp: "2026-09-11T07:00:00.000Z",
  };
}

describe("validateHandoff", () => {
  it("accepts a complete structured handoff", () => {
    const handoff = validHandoff();

    expect(validateHandoff(handoff)).toBe(handoff);
  });

  it("rejects empty evidence references", () => {
    expect(() =>
      validateHandoff({ ...validHandoff(), evidenceIds: [] }),
    ).toThrow("invalid handoff");
  });

  it("rejects missing uncertainties", () => {
    expect(() =>
      validateHandoff({
        ...validHandoff(),
        uncertainties: undefined as never,
      }),
    ).toThrow("invalid handoff");
  });

  it("rejects missing artifact references", () => {
    expect(() =>
      validateHandoff({ ...validHandoff(), artifactRefs: [] }),
    ).toThrow("invalid handoff");
  });

  it("rejects version zero", () => {
    expect(() =>
      validateHandoff({ ...validHandoff(), version: 0 }),
    ).toThrow("invalid handoff");
  });
});
