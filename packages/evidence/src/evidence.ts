import type { Database } from "@forge/store";
import type { EvidenceRecord, RegisterEvidenceInput } from "./types.js";

export class EvidenceService {
  constructor(private readonly db: Database) {}

  register(input: RegisterEvidenceInput): EvidenceRecord {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO core_evidence (
          id, artifact_id, run_id, claim, source_kind, source_ref, sha256,
          metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.artifactId ?? null,
        input.runId ?? null,
        input.claim,
        input.sourceKind,
        input.sourceRef,
        input.sha256 ?? null,
        JSON.stringify(input.metadata ?? {}),
        createdAt,
      );
    return this.get(input.id);
  }

  get(id: string): EvidenceRecord {
    const row = this.db
      .prepare(
        `SELECT id, artifact_id, run_id, claim, source_kind, source_ref, sha256,
                metadata_json, created_at
         FROM core_evidence
         WHERE id = ?`,
      )
      .get(id) as EvidenceRow | undefined;
    if (!row) {
      throw new Error(`evidence not found: ${id}`);
    }
    return mapEvidence(row);
  }

  listForRun(runId: string): EvidenceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, artifact_id, run_id, claim, source_kind, source_ref, sha256,
                metadata_json, created_at
         FROM core_evidence
         WHERE run_id = ?
         ORDER BY created_at`,
      )
      .all(runId) as EvidenceRow[];
    return rows.map(mapEvidence);
  }
}

type EvidenceRow = {
  id: string;
  artifact_id: string | null;
  run_id: string | null;
  claim: string;
  source_kind: string;
  source_ref: string;
  sha256: string | null;
  metadata_json: string;
  created_at: string;
};

function mapEvidence(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    artifactId: row.artifact_id ?? undefined,
    runId: row.run_id ?? undefined,
    claim: row.claim,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    sha256: row.sha256 ?? undefined,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export { mapEvidence };
