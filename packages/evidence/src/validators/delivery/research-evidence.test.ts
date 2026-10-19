import { describe, expect, it } from "vitest";
import type { ValidationInput } from "../../types.js";
import { ResearchEvidenceValidator } from "./research-evidence.js";

describe("ResearchEvidenceValidator", () => {
  const validator = new ResearchEvidenceValidator();

  it("fails blocking when a fact has no citation", async () => {
    const result = await validator.validate(
      input({
        researchClaims: [
          { id: "claim-1", classification: "fact", evidenceIds: [] },
        ],
        evidence: [],
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      layer: "process",
      severity: "blocking",
      details: { uncitedClaimIds: ["claim-1"] },
    });
  });

  it("fails blocking when cited evidence is missing or stale", async () => {
    const result = await validator.validate(
      input({
        researchClaims: [
          {
            id: "claim-1",
            classification: "fact",
            evidenceIds: ["missing", "stale", "fresh"],
          },
        ],
        evidence: [
          { id: "stale", version: 1, currentVersion: 2 },
          { id: "fresh", version: 2, currentVersion: 2 },
        ],
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      severity: "blocking",
      details: {
        missingEvidenceIds: ["missing"],
        staleEvidenceIds: ["stale"],
      },
    });
  });

  it("fails blocking when a fact has malformed evidenceIds", async () => {
    const result = await validator.validate(
      input({
        researchClaims: [
          { id: "claim-bad", classification: "fact" },
          { id: "claim-null", classification: "fact", evidenceIds: null },
          { id: "claim-mixed", classification: "fact", evidenceIds: ["ok", 1] },
        ],
        evidence: [{ id: "ok", version: 1, currentVersion: 1 }],
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      severity: "blocking",
      details: {
        uncitedClaimIds: ["claim-bad", "claim-null", "claim-mixed"],
      },
    });
  });

  it("passes cited facts and ignores citations on non-facts", async () => {
    const result = await validator.validate(
      input({
        researchClaims: [
          { id: "fact-1", classification: "fact", evidenceIds: ["fresh"] },
          { id: "unknown-1", classification: "unknown", evidenceIds: [] },
        ],
        evidence: [{ id: "fresh", version: 2, currentVersion: 2 }],
      }),
    );

    expect(result).toMatchObject({
      status: "passed",
      layer: "process",
      severity: "info",
      evidenceIds: ["fresh"],
    });
  });
});

function input(context: Record<string, unknown>): ValidationInput {
  return {
    runId: "run-1",
    deliveryId: "delivery-1",
    artifactIds: [],
    evidenceIds: [],
    context,
  };
}
