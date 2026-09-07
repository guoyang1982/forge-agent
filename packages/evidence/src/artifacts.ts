import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
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
    const canonicalRoot = await prepareArtifactDirectory(
      this.artifactRoot,
      dirname(absolutePath),
    );

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
    let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await assertSecurePath(this.artifactRoot, tempPath, true);
      await assertCanonicalParent(canonicalRoot, dirname(tempPath));
      tempHandle = await open(
        tempPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      await tempHandle.writeFile(input.content);
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = undefined;
      await assertSecurePath(this.artifactRoot, tempPath, false);
      await assertCanonicalParent(canonicalRoot, dirname(tempPath));
      await rename(tempPath, absolutePath);
    } catch (error) {
      await tempHandle?.close().catch(() => undefined);
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
    const canonicalRoot = await requireArtifactRoot(this.artifactRoot);
    await assertSecurePath(this.artifactRoot, absolutePath, false);
    await assertCanonicalParent(canonicalRoot, dirname(absolutePath));
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isSymbolicLinkError(error)) {
        throw new ArtifactAccessError("symbolic links are not allowed in artifact paths");
      }
      throw error;
    }
    let content: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new ArtifactAccessError("artifact content must be a regular file");
      }
      await assertCanonicalParent(canonicalRoot, dirname(absolutePath));
      content = await handle.readFile();
    } finally {
      await handle.close();
    }
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

async function prepareArtifactDirectory(
  root: string,
  directory: string,
): Promise<string> {
  const resolvedRoot = resolve(root);
  try {
    const rootStat = await lstat(resolvedRoot);
    assertRootStat(rootStat);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    await mkdir(resolvedRoot, { recursive: true });
    assertRootStat(await lstat(resolvedRoot));
  }
  const canonicalRoot = resolve(await realpath(resolvedRoot));
  await ensureDirectoryTree(resolvedRoot, directory);
  await assertSecurePath(resolvedRoot, directory, false);
  await assertCanonicalParent(canonicalRoot, directory);
  return canonicalRoot;
}

async function ensureDirectoryTree(root: string, directory: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedDirectory = resolve(directory);
  if (
    resolvedDirectory !== resolvedRoot &&
    !resolvedDirectory.startsWith(resolvedRoot + sep)
  ) {
    throw new ArtifactAccessError("artifact path escapes storage root");
  }
  let cursor = resolvedRoot;
  const relative = resolvedDirectory
    .slice(resolvedRoot.length)
    .split(sep)
    .filter(Boolean);
  for (const segment of relative) {
    cursor = join(cursor, segment);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isAlreadyExistsError(mkdirError)) throw mkdirError;
      }
      stat = await lstat(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ArtifactAccessError(
        "symbolic links are not allowed in artifact paths",
      );
    }
  }
}

async function requireArtifactRoot(root: string): Promise<string> {
  const resolvedRoot = resolve(root);
  assertRootStat(await lstat(resolvedRoot));
  return resolve(await realpath(resolvedRoot));
}

function assertRootStat(stat: Awaited<ReturnType<typeof lstat>>): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ArtifactAccessError(
      "artifact storage root must be a real directory",
    );
  }
}

async function assertSecurePath(
  root: string,
  target: string,
  allowMissingLeaf: boolean,
): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + sep)
  ) {
    throw new ArtifactAccessError("artifact path escapes storage root");
  }

  assertRootStat(await lstat(resolvedRoot));
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
        throw new ArtifactAccessError(
          "symbolic links are not allowed in artifact paths",
        );
      }
    } catch (error) {
      if (error instanceof ArtifactAccessError) {
        throw error;
      }
      if (isNotFoundError(error) && allowMissingLeaf && cursor === resolvedTarget) {
        return;
      }
      throw error;
    }
  }
}

async function assertCanonicalParent(
  canonicalRoot: string,
  directory: string,
): Promise<void> {
  const canonicalDirectory = resolve(await realpath(directory));
  if (
    canonicalDirectory !== canonicalRoot &&
    !canonicalDirectory.startsWith(canonicalRoot + sep)
  ) {
    throw new ArtifactAccessError("artifact path escapes storage root");
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

function isSymbolicLinkError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["ELOOP", "EMLINK"].includes((error as { code?: string }).code ?? "")
  );
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
