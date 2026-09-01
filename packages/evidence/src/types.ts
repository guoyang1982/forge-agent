export interface ValidationResult {
  status: "passed" | "failed" | "inconclusive";
  layer: "result" | "process" | "answer";
  severity: "info" | "warning" | "blocking";
  evidenceIds: string[];
  summary: string;
}

export interface ArtifactRecord {
  id: string;
  producerRunId: string;
  producerStepId?: string;
  mediaType: string;
  sha256: string;
  contentRef: string;
  sizeBytes: number;
  accessScope: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RegisterArtifactInput {
  id: string;
  producerRunId: string;
  producerStepId?: string;
  mediaType: string;
  content: Buffer;
  accessScope?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface EvidenceRecord {
  id: string;
  artifactId?: string;
  runId?: string;
  claim: string;
  sourceKind: string;
  sourceRef: string;
  sha256?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RegisterEvidenceInput {
  id: string;
  artifactId?: string;
  runId?: string;
  claim: string;
  sourceKind: string;
  sourceRef: string;
  sha256?: string;
  metadata?: Record<string, unknown>;
}

export interface ValidationInput {
  runId: string;
  deliveryId: string;
  artifactIds: string[];
  evidenceIds: string[];
  context?: Record<string, unknown>;
}

export interface Validator {
  id: string;
  layer: ValidationResult["layer"];
  validate(input: ValidationInput): Promise<ValidationResult>;
}
