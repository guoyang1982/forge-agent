export interface Handoff {
  conclusion: string;
  recommendedActions: string[];
  completedScope: string[];
  incompleteScope: string[];
  artifactRefs: string[];
  evidenceIds: string[];
  assumptions: string[];
  uncertainties: string[];
  risks: string[];
  downstreamQuestions: string[];
  version: string | number;
  from: string;
  to: string;
  timestamp: string;
}

export function validateHandoff<T extends Handoff>(handoff: T): T {
  if (
    !handoff ||
    !nonEmptyString(handoff.conclusion) ||
    !stringArray(handoff.recommendedActions) ||
    !stringArray(handoff.completedScope) ||
    !stringArray(handoff.incompleteScope) ||
    !nonEmptyStringArray(handoff.artifactRefs) ||
    !nonEmptyStringArray(handoff.evidenceIds) ||
    !stringArray(handoff.assumptions) ||
    !stringArray(handoff.uncertainties) ||
    !stringArray(handoff.risks) ||
    !stringArray(handoff.downstreamQuestions) ||
    !validVersion(handoff.version) ||
    !nonEmptyString(handoff.from) ||
    !nonEmptyString(handoff.to) ||
    !validTimestamp(handoff.timestamp)
  ) {
    throw new Error("invalid handoff");
  }
  return handoff;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return stringArray(value) && value.length > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validVersion(value: unknown): value is string | number {
  return (
    (nonEmptyString(value)) ||
    (typeof value === "number" && Number.isFinite(value) && value >= 1)
  );
}

function validTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}
