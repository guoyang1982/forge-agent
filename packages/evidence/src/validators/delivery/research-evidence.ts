import type {
  ValidationInput,
  ValidationResult,
  Validator,
} from "../../types.js";

interface ContextClaim {
  id: string;
  classification: string;
  evidenceIds: string[];
}

interface ContextEvidence {
  id: string;
  stale?: boolean;
  isStale?: boolean;
  version?: string | number;
  currentVersion?: string | number;
  latestVersion?: string | number;
  versionRef?: string;
  currentVersionRef?: string;
}

export class ResearchEvidenceValidator implements Validator {
  readonly id = "research-evidence";
  readonly layer = "process";

  async validate(input: ValidationInput): Promise<ValidationResult> {
    const { claims, malformedFactClaimIds } = readClaims(input.context);
    const evidence = readEvidence(input.context);
    const evidenceById = new Map(evidence.map((record) => [record.id, record]));
    const facts = claims.filter(({ classification }) => classification === "fact");
    const uncitedClaimIds = unique([
      ...facts
        .filter(({ evidenceIds }) => evidenceIds.length === 0)
        .map(({ id }) => id),
      ...malformedFactClaimIds,
    ]);
    const citedEvidenceIds = unique(facts.flatMap(({ evidenceIds }) => evidenceIds));
    const missingEvidenceIds = citedEvidenceIds.filter((id) => !evidenceById.has(id));
    const staleEvidenceIds = citedEvidenceIds.filter((id) => {
      const record = evidenceById.get(id);
      return record !== undefined && isStale(record);
    });
    const failed =
      uncitedClaimIds.length > 0 ||
      missingEvidenceIds.length > 0 ||
      staleEvidenceIds.length > 0;

    return {
      status: failed ? "failed" : "passed",
      layer: this.layer,
      severity: failed ? "blocking" : "info",
      evidenceIds: citedEvidenceIds,
      summary: failed
        ? "research facts have missing or stale supporting evidence"
        : "research facts have current supporting evidence",
      details: {
        uncitedClaimIds,
        missingEvidenceIds,
        staleEvidenceIds,
      },
    };
  }
}

function readClaims(context: Record<string, unknown> | undefined): {
  claims: ContextClaim[];
  malformedFactClaimIds: string[];
} {
  const value = context?.researchClaims ?? context?.claims;
  if (!Array.isArray(value)) {
    return { claims: [], malformedFactClaimIds: [] };
  }
  const claims: ContextClaim[] = [];
  const malformedFactClaimIds: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      continue;
    }
    if (
      entry.classification === "fact" &&
      (!Array.isArray(entry.evidenceIds) ||
        !entry.evidenceIds.every((id) => typeof id === "string"))
    ) {
      malformedFactClaimIds.push(entry.id);
      continue;
    }
    if (isContextClaim(entry)) {
      claims.push(entry);
    }
  }
  return { claims, malformedFactClaimIds };
}

function readEvidence(context: Record<string, unknown> | undefined): ContextEvidence[] {
  const value =
    context?.evidence ?? context?.evidenceRecords ?? context?.researchEvidence;
  if (Array.isArray(value)) {
    return value.filter(isContextEvidence);
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([id, record]) =>
      isRecord(record) ? [{ id, ...record } as ContextEvidence] : [],
    );
  }
  return [];
}

function isContextClaim(value: unknown): value is ContextClaim {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.classification === "string" &&
    Array.isArray(value.evidenceIds) &&
    value.evidenceIds.every((id) => typeof id === "string")
  );
}

function isContextEvidence(value: unknown): value is ContextEvidence {
  return isRecord(value) && typeof value.id === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStale(record: ContextEvidence): boolean {
  if (record.stale === true || record.isStale === true) {
    return true;
  }
  const current = record.currentVersion ?? record.latestVersion;
  if (record.version !== undefined && current !== undefined) {
    return record.version !== current;
  }
  return (
    record.versionRef !== undefined &&
    record.currentVersionRef !== undefined &&
    record.versionRef !== record.currentVersionRef
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
