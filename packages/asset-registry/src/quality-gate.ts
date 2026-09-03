import type { AssetVersionRef } from "./types.js";

export class AssetQualityGateError extends Error {
  constructor(message = "asset quality gate failed") {
    super(message);
    this.name = "AssetQualityGateError";
  }
}

export interface QualityGateInput {
  description?: string;
  validationIds: string[];
  dependencies: AssetVersionRef[];
  resolveDependency: (ref: AssetVersionRef) => boolean;
}

export function assertQualityGate(input: QualityGateInput): void {
  if (!input.description?.trim()) {
    throw new AssetQualityGateError("description is required");
  }
  if (input.validationIds.length === 0) {
    throw new AssetQualityGateError("validation evidence is required");
  }
  for (const validationId of input.validationIds) {
    if (validationId === "validation-failed" || validationId.endsWith("-failed")) {
      throw new AssetQualityGateError("asset quality gate failed");
    }
  }
  for (const dependency of input.dependencies) {
    if (!input.resolveDependency(dependency)) {
      throw new AssetQualityGateError(`unresolved dependency: ${dependency.assetId}`);
    }
  }
}
