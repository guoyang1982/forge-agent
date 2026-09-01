import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Database } from "@forge/store";
import type { ArtifactRecord, RegisterArtifactInput } from "./types.js";

export class ArtifactTamperError extends Error {
  readonly code = "ARTIFACT_TAMPER" as const;

  constructor(message = "artifact content hash mismatch") {
    super(message);
    this.name = "ArtifactTamperError";
  }
}

export class ArtifactAccessError extends Error {
  readonly code = "ARTIFACT_ACCESS_DENIED" as const;

  constructor(message = "artifact access denied") {
    super(message);
    this.name = "ArtifactAccessError";
  }
}

export class ArtifactService {
  constructor(
    private readonly db: Database,
    private readonly artifactRoot: string,
  ) {}

  async register(input: RegisterArtifactInput): Promise<ArtifactRecord> {
    const sha256 = hashContent(input.content);
    const contentRef = join("artifacts", input.id.slice(0, 2), input.id);
    const absolutePath = join(this.artifactRoot, contentRef);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.content);

    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO core_artifacts (
          id, producer_run_id, producer_step_id, media_type, sha256, content_ref,
          size_bytes, access_scope_json, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.producerRunId,
        input.producerStepId ?? null,
        input.mediaType,
        sha256,
        contentRef,
        input.content.byteLength,
        JSON.stringify(input.accessScope ?? {}),
        JSON.stringify(input.metadata ?? {}),
        createdAt,
      );

    return this.get(input.id);
  }

  get(id: string): ArtifactRecord {
    const row = this.db
      .prepare(
        `SELECT id, producer_run_id, producer_step_id, media_type, sha256, content_ref,
                size_bytes, access_scope_json, metadata_json, created_at
         FROM core_artifacts
         WHERE id = ?`,
      )
      .get(id) as ArtifactRow | undefined;
    if (!row) {
      throw new Error(`artifact not found: ${id}`);
    }
    return mapArtifact(row);
  }

  async readContent(
    id: string,
    scope: Record<string, unknown> = {},
  ): Promise<Buffer> {
    const artifact = this.get(id);
    assertAccessScope(artifact.accessScope, scope);
    const absolutePath = join(this.artifactRoot, artifact.contentRef);
    const content = await readFile(absolutePath);
    if (hashContent(content) !== artifact.sha256) {
      throw new ArtifactTamperError();
    }
    return content;
  }
}

function assertAccessScope(
  requiredScope: Record<string, unknown>,
  requestedScope: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(requiredScope)) {
    if (requestedScope[key] !== value) {
      throw new ArtifactAccessError();
    }
  }
}

type ArtifactRow = {
  id: string;
  producer_run_id: string;
  producer_step_id: string | null;
  media_type: string;
  sha256: string;
  content_ref: string;
  size_bytes: number;
  access_scope_json: string;
  metadata_json: string;
  created_at: string;
};

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    producerRunId: row.producer_run_id,
    producerStepId: row.producer_step_id ?? undefined,
    mediaType: row.media_type,
    sha256: row.sha256,
    contentRef: row.content_ref,
    sizeBytes: row.size_bytes,
    accessScope: JSON.parse(row.access_scope_json) as Record<string, unknown>,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export function hashContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export { mapArtifact };
