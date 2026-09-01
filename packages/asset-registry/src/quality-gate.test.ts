import { describe, expect, it } from "vitest";
import { assertQualityGate, AssetQualityGateError } from "./quality-gate.js";

describe("assertQualityGate", () => {
  it("passes when description permissions security and validations succeed", () => {
    expect(() =>
      assertQualityGate({
        description: "launch workflow",
        validationIds: ["validation-pass"],
        dependencies: [],
        permissionReviewed: true,
        securityValidationId: "security-pass",
        resolveDependency: () => true,
      }),
    ).not.toThrow();
  });

  it("blocks publish when security or evaluation validation fails", () => {
    expect(() =>
      assertQualityGate({
        description: "launch workflow",
        validationIds: ["validation-failed"],
        dependencies: [],
        permissionReviewed: true,
        securityValidationId: "security-pass",
        resolveDependency: () => true,
      }),
    ).toThrow(AssetQualityGateError);
    expect(() =>
      assertQualityGate({
        description: "launch workflow",
        validationIds: ["validation-pass"],
        dependencies: [],
        permissionReviewed: true,
        securityValidationId: "validation-failed",
        resolveDependency: () => true,
      }),
    ).toThrow(/asset quality gate failed/);
  });

  it("requires permission review and dependency resolution", () => {
    expect(() =>
      assertQualityGate({
        description: "launch workflow",
        validationIds: ["validation-pass"],
        dependencies: [{ assetId: "missing" }],
        permissionReviewed: true,
        securityValidationId: "security-pass",
        resolveDependency: () => false,
      }),
    ).toThrow(/unresolved dependency/);

    expect(() =>
      assertQualityGate({
        description: "launch workflow",
        validationIds: ["validation-pass"],
        dependencies: [],
        permissionReviewed: false,
        securityValidationId: "security-pass",
        resolveDependency: () => true,
      }),
    ).toThrow(/permission review required/);
  });
});
