import { createHash, randomUUID } from "node:crypto";
import { realpath, lstat } from "node:fs/promises";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Database } from "@forge/store";
import type { ArtifactRecord, RegisterArtifactInput } from "./types.js";

const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

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

export class ArtifactIdError extends Error {
  readonly code = "ARTIFACT_ID_INVALID" as const;

  constructor(message = "artifact id is invalid") {
    super(message);
    this.name = "ArtifactIdError";
  }
}

export class ArtifactDuplicateError extends Error {
  readonly code = "ARTIFACT_DUPLICATE" as const;

  constructor(message = "artifact id already exists") {
    super(message);
    this.name = "ArtifactDuplicateError";
  }
}

export class ArtifactService {
  constructor(
    private readonly db: Database,
    private readonly artifactRoot: string,
  ) {}

  async register(input: RegisterArtifactInput): Promise<ArtifactRecord> {
    validateArtifactId(input.id);
    const sha256 = hashContent(input.content);
    const contentRef = join("artifacts", input.id.slice(0, 2), input.id);
    const absolutePath = join(this.artifactRoot, contentRef);
    await assertPathWithinRoot(this.artifactRoot, absolutePath);

    const createdAt = new Date().toISOString();
    try {
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
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new ArtifactDuplicateError();
      }
      throw error;
    }

    const tempPath = `${absolutePath}.partial-${randomUUID()}`;
    try {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(tempPath, input.content);
      await rename(tempPath, absolutePath);
    } catch (error) {
      this.db.prepare(`DELETE FROM core_artifacts WHERE id = ?`).run(input.id);
      try {
        await unlink(tempPath);
      } catch {
        // best-effort cleanup
      }
      throw error;
    }

    return this.get(input.id);
  }

  get(id: string): ArtifactRecord {
    validateArtifactId(id);
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
    validateArtifactId(id);
    const artifact = this.get(id);
    assertAccessScope(artifact.accessScope, scope);
    const absolutePath = join(this.artifactRoot, artifact.contentRef);
    await assertPathWithinRoot(this.artifactRoot, absolutePath);
    const content = await readFile(absolutePath);
    if (hashContent(content) !== artifact.sha256) {
      throw new ArtifactTamperError();
    }
    return content;
  }
}

function validateArtifactId(id: string): void {
  if (!SAFE_ARTIFACT_ID.test(id) || id.includes("..")) {
    throw new ArtifactIdError();
  }
}

async function assertPathWithinRoot(root: string, target: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + sep)
  ) {
    throw new ArtifactAccessError("artifact path escapes storage root");
  }

  let cursor = resolvedRoot;
  const relative = resolvedTarget
    .slice(resolvedRoot.length)
    .split(sep)
    .filter(Boolean);
  for (const segment of relative) {
    cursor = join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        const linked = resolve(await realpath(cursor));
        if (linked !== resolvedRoot && !linked.startsWith(resolvedRoot + sep)) {
          throw new ArtifactAccessError("artifact path escapes storage root");
        }
      }
    } catch (error) {
      if (error instanceof ArtifactAccessError) {
        throw error;
      }
      break;
    }
  }
}

function isSqliteConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
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
