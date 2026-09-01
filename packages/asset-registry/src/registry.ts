import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@forge/store";
import { assertQualityGate } from "./quality-gate.js";
import type {
  AssetKind,
  AssetRecord,
  AssetState,
  AssetVersion,
  AssetVersionRef,
  CreateDraftInput,
  PublishInput,
} from "./types.js";

export class ImmutableAssetVersionError extends Error {
  constructor(message = "immutable asset version") {
    super(message);
    this.name = "ImmutableAssetVersionError";
  }
}

export class AssetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetNotFoundError";
  }
}

export class AssetRegistry {
  constructor(private readonly db: Database) {}

  createDraft(input: CreateDraftInput): AssetRecord {
    if (!input.ownerSubject?.kind || !input.ownerSubject?.id) {
      throw new Error("asset owner is required");
    }

    const now = new Date().toISOString();
    const assetId = input.id ?? randomUUID();
    if (input.id) {
      const existing = this.db
        .prepare(`SELECT id FROM core_assets WHERE id = ?`)
        .get(assetId);
      if (existing) {
        throw new Error(`asset already exists: ${assetId}`);
      }
    }

    const versionId = randomUUID();
    const ownerSubjectId = formatOwnerSubjectId(
      input.ownerSubject.kind,
      input.ownerSubject.id,
    );

    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO core_assets (
            id, kind, name, owner_subject_kind, owner_subject_id, state,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          assetId,
          input.kind,
          input.name,
          input.ownerSubject.kind,
          input.ownerSubject.id,
          now,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO core_asset_versions (
            id, asset_id, version, state, owner_subject_id, source_ref,
            content_hash, dependencies_json, validation_ids_json, content_json,
            created_at
          ) VALUES (?, ?, 1, 'draft', ?, ?, ?, ?, '[]', ?, ?)`,
        )
        .run(
          versionId,
          assetId,
          ownerSubjectId,
          input.sourceRef,
          input.contentHash,
          JSON.stringify(input.dependencies ?? []),
          input.content ? JSON.stringify(input.content) : null,
          now,
        );

      this.persistDependencies(versionId, input.dependencies ?? [], now);
      return this.getAsset(assetId);
    })();
  }

  createVersionDraft(
    assetId: string,
    input: Omit<CreateDraftInput, "id" | "kind" | "name" | "ownerSubject">,
  ): AssetVersion {
    const asset = this.requireAsset(assetId);
    const now = new Date().toISOString();
    const nextVersion =
      (this.db
        .prepare(
          `SELECT COALESCE(MAX(version), 0) AS maxVersion
           FROM core_asset_versions WHERE asset_id = ?`,
        )
        .get(assetId) as { maxVersion: number }).maxVersion + 1;

    const versionId = randomUUID();
    const ownerSubjectId = formatOwnerSubjectId(
      asset.ownerSubjectKind,
      asset.ownerSubjectId,
    );

    this.db
      .prepare(
        `INSERT INTO core_asset_versions (
          id, asset_id, version, state, owner_subject_id, source_ref,
          content_hash, dependencies_json, validation_ids_json, content_json,
          created_at
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(
        versionId,
        assetId,
        nextVersion,
        ownerSubjectId,
        input.sourceRef,
        input.contentHash,
        JSON.stringify(input.dependencies ?? []),
        input.content ? JSON.stringify(input.content) : null,
        now,
      );

    this.persistDependencies(versionId, input.dependencies ?? [], now);
    this.db
      .prepare(`UPDATE core_assets SET state = 'draft', updated_at = ? WHERE id = ?`)
      .run(now, assetId);

    return this.getVersion(versionId);
  }

  publish(assetId: string, input: PublishInput): AssetVersion {
    const draft = this.getDraftVersion(assetId);
    if (!draft) {
      throw new Error(`no draft version to publish for asset: ${assetId}`);
    }

    const description =
      input.description ??
      (this.readVersionContent(draft.id)?.description as string | undefined);
    const dependencies = draft.dependencies;

    assertQualityGate({
      description,
      validationIds: input.validationIds,
      dependencies,
      permissionReviewed: input.permissionReviewed ?? true,
      securityValidationId: input.securityValidationId ?? "validation-pass",
      resolveDependency: (ref) => this.resolveDependencyRef(ref),
    });

    if (this.hasDependencyCycle(assetId, dependencies)) {
      throw new Error("dependency cycle detected");
    }

    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE core_asset_versions
           SET state = 'published', validation_ids_json = ?, created_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(input.validationIds), now, draft.id);

      this.db
        .prepare(
          `UPDATE core_assets SET state = 'published', updated_at = ? WHERE id = ?`,
        )
        .run(now, assetId);

      return this.getVersion(draft.id);
    })();
  }

  deprecate(assetId: string): AssetRecord {
    const asset = this.requireAsset(assetId);
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE core_assets SET state = 'deprecated', updated_at = ? WHERE id = ?`)
      .run(now, assetId);
    this.db
      .prepare(
        `UPDATE core_asset_versions
         SET state = 'deprecated'
         WHERE asset_id = ? AND state = 'published'`,
      )
      .run(assetId);
    return { ...asset, state: "deprecated", updatedAt: now };
  }

  rollback(assetId: string, targetVersionId: string): AssetVersion {
    const asset = this.requireAsset(assetId);
    const target = this.getVersion(targetVersionId);
    if (target.assetId !== assetId) {
      throw new Error("rollback target must belong to the same asset");
    }

    const now = new Date().toISOString();
    const nextVersion =
      (this.db
        .prepare(
          `SELECT COALESCE(MAX(version), 0) AS maxVersion
           FROM core_asset_versions WHERE asset_id = ?`,
        )
        .get(assetId) as { maxVersion: number }).maxVersion + 1;

    const versionId = randomUUID();
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO core_asset_versions (
            id, asset_id, version, state, owner_subject_id, source_ref,
            content_hash, dependencies_json, validation_ids_json, created_at
          ) VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          assetId,
          nextVersion,
          target.ownerSubjectId,
          target.sourceRef,
          target.contentHash,
          JSON.stringify(target.dependencies),
          JSON.stringify(target.validationIds),
          now,
        );

      this.persistDependencies(versionId, target.dependencies, now);

      this.db
        .prepare(
          `UPDATE core_assets SET state = 'rolled_back', updated_at = ? WHERE id = ?`,
        )
        .run(now, assetId);

      this.db
        .prepare(`UPDATE core_assets SET state = 'published', updated_at = ? WHERE id = ?`)
        .run(now, assetId);

    void asset;
      return this.getVersion(versionId);
    })();
  }

  resolveVersion(assetId: string, version?: number): AssetVersion {
    const row = version
      ? (this.db
          .prepare(
            `SELECT id FROM core_asset_versions
             WHERE asset_id = ? AND version = ?`,
          )
          .get(assetId, version) as { id: string } | undefined)
      : (this.db
          .prepare(
            `SELECT id FROM core_asset_versions
             WHERE asset_id = ?
             ORDER BY version DESC
             LIMIT 1`,
          )
          .get(assetId) as { id: string } | undefined);

    if (!row) {
      throw new AssetNotFoundError(`asset version not found: ${assetId}`);
    }
    return this.getVersion(row.id);
  }

  mutateVersion(_versionId: string, _patch: Record<string, unknown>): never {
    throw new ImmutableAssetVersionError();
  }

  getAsset(assetId: string): AssetRecord {
    return this.requireAsset(assetId);
  }

  getVersion(versionId: string): AssetVersion {
    const row = this.db
      .prepare(
        `SELECT v.id, v.asset_id, a.kind, v.version, v.state, v.owner_subject_id,
                v.source_ref, v.content_hash, v.dependencies_json,
                v.validation_ids_json, v.created_at
         FROM core_asset_versions v
         JOIN core_assets a ON a.id = v.asset_id
         WHERE v.id = ?`,
      )
      .get(versionId) as VersionRow | undefined;
    if (!row) {
      throw new AssetNotFoundError(`asset version not found: ${versionId}`);
    }
    return mapVersion(row);
  }

  private getDraftVersion(assetId: string): AssetVersion | null {
    const row = this.db
      .prepare(
        `SELECT v.id, v.asset_id, a.kind, v.version, v.state, v.owner_subject_id,
                v.source_ref, v.content_hash, v.dependencies_json,
                v.validation_ids_json, v.created_at
         FROM core_asset_versions v
         JOIN core_assets a ON a.id = v.asset_id
         WHERE v.asset_id = ? AND v.state = 'draft'
         ORDER BY v.version DESC
         LIMIT 1`,
      )
      .get(assetId) as VersionRow | undefined;
    return row ? mapVersion(row) : null;
  }

  private getLatestVersion(assetId: string): AssetVersion | null {
    const row = this.db
      .prepare(
        `SELECT v.id, v.asset_id, a.kind, v.version, v.state, v.owner_subject_id,
                v.source_ref, v.content_hash, v.dependencies_json,
                v.validation_ids_json, v.created_at
         FROM core_asset_versions v
         JOIN core_assets a ON a.id = v.asset_id
         WHERE v.asset_id = ?
         ORDER BY v.version DESC
         LIMIT 1`,
      )
      .get(assetId) as VersionRow | undefined;
    return row ? mapVersion(row) : null;
  }

  private requireAsset(assetId: string): AssetRecord {
    const row = this.db
      .prepare(
        `SELECT id, kind, name, owner_subject_kind, owner_subject_id, state,
                created_at, updated_at
         FROM core_assets WHERE id = ?`,
      )
      .get(assetId) as AssetRow | undefined;
    if (!row) {
      throw new AssetNotFoundError(`asset not found: ${assetId}`);
    }
    return mapAsset(row);
  }

  private resolveDependencyRef(ref: AssetVersionRef): boolean {
    const row = ref.version
      ? (this.db
          .prepare(
            `SELECT id FROM core_asset_versions
             WHERE asset_id = ? AND version = ? AND state = 'published'`,
          )
          .get(ref.assetId, ref.version) as { id: string } | undefined)
      : (this.db
          .prepare(
            `SELECT id FROM core_asset_versions
             WHERE asset_id = ? AND state = 'published'
             ORDER BY version DESC
             LIMIT 1`,
          )
          .get(ref.assetId) as { id: string } | undefined);
    return Boolean(row);
  }

  private hasDependencyCycle(
    assetId: string,
    dependencies: AssetVersionRef[],
  ): boolean {
    const visiting = new Set<string>();

    const visit = (currentId: string, depth: number): boolean => {
      if (depth > 0 && currentId === assetId) {
        return true;
      }
      if (visiting.has(currentId)) {
        return false;
      }
      visiting.add(currentId);

      const refs =
        currentId === assetId
          ? dependencies
          : this.safeDependencies(currentId);

      for (const ref of refs) {
        if (visit(ref.assetId, depth + 1)) {
          return true;
        }
      }

      visiting.delete(currentId);
      return false;
    };

    return visit(assetId, 0);
  }

  private safeDependencies(assetId: string): AssetVersionRef[] {
    const row = this.db
      .prepare(
        `SELECT v.dependencies_json
         FROM core_asset_versions v
         WHERE v.asset_id = ? AND v.state = 'published'
         ORDER BY v.version DESC
         LIMIT 1`,
      )
      .get(assetId) as { dependencies_json: string } | undefined;
    if (!row) {
      return [];
    }
    return JSON.parse(row.dependencies_json) as AssetVersionRef[];
  }

  private persistDependencies(
    versionId: string,
    dependencies: AssetVersionRef[],
    createdAt: string,
  ): void {
    for (const dependency of dependencies) {
      this.db
        .prepare(
          `INSERT INTO core_asset_dependencies (
            id, asset_version_id, depends_on_asset_id, depends_on_version, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          versionId,
          dependency.assetId,
          dependency.version ?? null,
          createdAt,
        );
    }
  }

  private readVersionContent(versionId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare(`SELECT content_json FROM core_asset_versions WHERE id = ?`)
      .get(versionId) as { content_json: string | null } | undefined;
    if (!row?.content_json) {
      return null;
    }
    return JSON.parse(row.content_json) as Record<string, unknown>;
  }
}

interface AssetRow {
  id: string;
  kind: AssetKind;
  name: string;
  owner_subject_kind: string;
  owner_subject_id: string;
  state: AssetState;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  asset_id: string;
  kind: AssetKind;
  version: number;
  state: AssetState;
  owner_subject_id: string;
  source_ref: string;
  content_hash: string;
  dependencies_json: string;
  validation_ids_json: string;
  created_at: string;
}

function mapAsset(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    ownerSubjectKind: row.owner_subject_kind,
    ownerSubjectId: row.owner_subject_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: VersionRow): AssetVersion {
  return {
    id: row.id,
    assetId: row.asset_id,
    kind: row.kind,
    version: row.version,
    state: row.state,
    ownerSubjectId: row.owner_subject_id,
    sourceRef: row.source_ref,
    contentHash: row.content_hash,
    dependencies: JSON.parse(row.dependencies_json) as AssetVersionRef[],
    validationIds: JSON.parse(row.validation_ids_json) as string[],
    createdAt: row.created_at,
  };
}

export function formatOwnerSubjectId(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function hashAssetContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
