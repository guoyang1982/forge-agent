import { describe, expect, it } from "vitest";
import { assertQualityGate, AssetQualityGateError } from "./quality-gate.js";

describe("assertQualityGate", () => {
  it("passes when description validations and dependencies succeed", () => {
    expect(() =>
      assertQualityGate({
        description: "launch workflow",
        validationIds: ["validation-pass"],
        dependencies: [],
        resolveDependency: () => true,
      }),
    ).not.toThrow();
  });

  it("blocks publish when validation fails", () => {
    expect(() =>
      assertQualityGate({
        description: "launch workflow",
        validationIds: ["validation-failed"],
        dependencies: [],
        resolveDependency: () => true,
      }),
    ).toThrow(AssetQualityGateError);
  });

  it("requires description, validations, and dependency resolution", () => {
    expect(() =>
      assertQualityGate({
        description: "launch workflow",
        validationIds: ["validation-pass"],
        dependencies: [{ assetId: "missing" }],
        resolveDependency: () => false,
      }),
    ).toThrow(/unresolved dependency/);

    expect(() =>
      assertQualityGate({
        description: "",
        validationIds: ["validation-pass"],
        dependencies: [],
        resolveDependency: () => true,
      }),
    ).toThrow(/description is required/);

    expect(() =>
      assertQualityGate({
        description: "launch workflow",
        validationIds: [],
        dependencies: [],
        resolveDependency: () => true,
      }),
    ).toThrow(/validation evidence is required/);
  });
});
