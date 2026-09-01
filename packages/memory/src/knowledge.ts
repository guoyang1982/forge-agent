import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@forge/store";
import {
  AssetRegistry,
  hashAssetContent,
  type AssetVersionRef,
} from "@forge/asset-registry";
import { chunkExtractedDocument } from "@forge/document-extract";

export interface KnowledgeAccessScope {
  companyId?: string;
  projectId?: string;
  teamId?: string;
}

export interface KnowledgeChunkInput {
  locator: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSourceInput {
  id?: string;
  name: string;
  sourceKind: string;
  uri?: string;
  accessScope?: KnowledgeAccessScope;
  content: string;
  chunks?: KnowledgeChunkInput[];
  ownerSubject: { kind: string; id: string };
  metadata?: Record<string, unknown>;
}

export interface KnowledgeQualityGateInput {
  validationIds: string[];
  permissionReviewed?: boolean;
  securityValidationId?: string;
  description?: string;
}

export interface KnowledgeAssetVersionRef {
  kind: "knowledge";
  assetId: string;
  version: number;
  assetVersionId: string;
}

export interface KnowledgeSyncResult {
  sourceId: string;
  versionId: string;
  version: number;
  contentHash: string;
  created: boolean;
  assetVersionRef: KnowledgeAssetVersionRef;
}

export interface KnowledgeSearchInput {
  query: string;
  limit?: number;
  scope?: KnowledgeAccessScope;
}

export interface KnowledgeHit {
  chunkId: string;
  text: string;
  score: number;
  sourceId: string;
  sourceVersionId: string;
  locator: string;
  contentHash: string;
}

export interface KnowledgeCitation {
  sourceId: string;
  sourceVersionId: string;
  chunkId: string;
  locator: string;
  text: string;
  contentHash: string;
}

const DEFAULT_CHUNK_SIZE = 1200;

export class KnowledgeStore {
  constructor(
    private readonly db: Database,
    private readonly assets: AssetRegistry,
    private readonly gate: KnowledgeQualityGateInput = {
      validationIds: ["validation-pass"],
      permissionReviewed: true,
      securityValidationId: "security-pass",
    },
  ) {}

  async syncSource(input: KnowledgeSourceInput): Promise<KnowledgeSyncResult> {
    const now = new Date().toISOString();
    const sourceId = this.resolveSourceId(input);
    const contentHash = hashContent(input.content);
    const existingSource = this.getSourceRow(sourceId);

    if (!existingSource) {
      this.db
        .prepare(
          `INSERT INTO core_knowledge_sources (
            id, name, source_kind, uri, access_scope_json, current_version_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          sourceId,
          input.name,
          input.sourceKind,
          input.uri ?? null,
          JSON.stringify(input.accessScope ?? {}),
          now,
          now,
        );
    } else {
      this.db
        .prepare(
          `UPDATE core_knowledge_sources
           SET name = ?, source_kind = ?, uri = ?, access_scope_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.name,
          input.sourceKind,
          input.uri ?? null,
          JSON.stringify(input.accessScope ?? {}),
          now,
          sourceId,
        );
    }

    const currentVersion = this.getCurrentVersion(sourceId);
    if (currentVersion?.content_hash === contentHash) {
      const assetVersion = this.requireAssetVersion(currentVersion.asset_version_id);
      return {
        sourceId,
        versionId: currentVersion.id,
        version: currentVersion.version,
        contentHash,
        created: false,
        assetVersionRef: {
          kind: "knowledge",
          assetId: assetVersion.asset_id,
          version: assetVersion.version,
          assetVersionId: assetVersion.id,
        },
      };
    }

    const nextVersion =
      (this.db
        .prepare(
          `SELECT COALESCE(MAX(version), 0) AS maxVersion
           FROM core_knowledge_source_versions
           WHERE source_id = ?`,
        )
        .get(sourceId) as { maxVersion: number }).maxVersion + 1;

    const assetId = knowledgeAssetId(sourceId);
    this.ensureKnowledgeAsset(assetId, input);
    const versionId = randomUUID();
    const assetVersion = this.publishKnowledgeAssetVersion(
      assetId,
      input,
      contentHash,
      nextVersion,
    );

    this.db
      .prepare(
        `INSERT INTO core_knowledge_source_versions (
          id, source_id, version, content_hash, asset_version_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        sourceId,
        nextVersion,
        contentHash,
        assetVersion.id,
        JSON.stringify(input.metadata ?? {}),
        now,
      );

    this.replaceChunks(versionId, this.resolveChunks(input));

    this.db
      .prepare(
        `UPDATE core_knowledge_sources
         SET current_version_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(versionId, now, sourceId);

    return {
      sourceId,
      versionId,
      version: nextVersion,
      contentHash,
      created: true,
      assetVersionRef: {
        kind: "knowledge",
        assetId,
        version: assetVersion.version,
        assetVersionId: assetVersion.id,
      },
    };
  }

  search(input: KnowledgeSearchInput): KnowledgeHit[] {
    const limit = input.limit ?? 8;
    const query = input.query.trim().toLowerCase();
    if (!query) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT
          chunk.id AS chunk_id,
          chunk.text AS text,
          chunk.locator AS locator,
          chunk.content_hash AS content_hash,
          source.id AS source_id,
          version.id AS source_version_id,
          source.access_scope_json AS access_scope_json
         FROM core_knowledge_chunks chunk
         INNER JOIN core_knowledge_source_versions version
           ON version.id = chunk.source_version_id
         INNER JOIN core_knowledge_sources source
           ON source.id = version.source_id
         WHERE source.current_version_id = version.id
           AND lower(chunk.text) LIKE ?`,
      )
      .all(`%${escapeLike(query)}%`) as SearchRow[];

    return rows
      .filter((row) => matchesScope(row.access_scope_json, input.scope))
      .map((row) => ({
        chunkId: row.chunk_id,
        text: row.text,
        score: scoreChunk(row.text, query),
        sourceId: row.source_id,
        sourceVersionId: row.source_version_id,
        locator: row.locator,
        contentHash: row.content_hash,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  getCitation(chunkId: string): KnowledgeCitation | null {
    const row = this.db
      .prepare(
        `SELECT
          chunk.id AS chunk_id,
          chunk.text AS text,
          chunk.locator AS locator,
          chunk.content_hash AS content_hash,
          source.id AS source_id,
          version.id AS source_version_id
         FROM core_knowledge_chunks chunk
         INNER JOIN core_knowledge_source_versions version
           ON version.id = chunk.source_version_id
         INNER JOIN core_knowledge_sources source
           ON source.id = version.source_id
         WHERE chunk.id = ?`,
      )
      .get(chunkId) as CitationRow | undefined;
    if (!row) {
      return null;
    }
    return {
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      chunkId: row.chunk_id,
      locator: row.locator,
      text: row.text,
      contentHash: row.content_hash,
    };
  }

  deleteSource(sourceId: string): void {
    const currentVersion = this.getCurrentVersion(sourceId);
    if (!currentVersion) {
      return;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(`DELETE FROM core_knowledge_chunks WHERE source_version_id = ?`)
      .run(currentVersion.id);
    this.db
      .prepare(
        `UPDATE core_knowledge_sources
         SET current_version_id = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, sourceId);
  }

  private ensureKnowledgeAsset(assetId: string, input: KnowledgeSourceInput): void {
    const existing = this.db
      .prepare(`SELECT id FROM core_assets WHERE id = ?`)
      .get(assetId);
    if (existing) {
      return;
    }
    this.assets.createDraft({
      id: assetId,
      kind: "knowledge",
      name: input.name,
      ownerSubject: input.ownerSubject,
      sourceRef: input.uri ?? `knowledge://${assetId}`,
      contentHash: hashAssetContent(input.content),
      description: input.name,
      content: { description: input.name },
    });
  }

  private publishKnowledgeAssetVersion(
    assetId: string,
    input: KnowledgeSourceInput,
    contentHash: string,
    nextVersion: number,
  ) {
    if (nextVersion > 1) {
      this.assets.createVersionDraft(assetId, {
        sourceRef: input.uri ?? `knowledge://${assetId}`,
        contentHash: hashAssetContent(input.content),
        description: input.name,
        content: { description: input.name, contentHash },
      });
    }
    return this.assets.publish(assetId, {
      validationIds: this.gate.validationIds,
      permissionReviewed: this.gate.permissionReviewed,
      securityValidationId: this.gate.securityValidationId,
      description: this.gate.description ?? input.name,
    });
  }

  private replaceChunks(
    sourceVersionId: string,
    chunks: KnowledgeChunkInput[],
  ): void {
    this.db
      .prepare(`DELETE FROM core_knowledge_chunks WHERE source_version_id = ?`)
      .run(sourceVersionId);
    const insert = this.db.prepare(
      `INSERT INTO core_knowledge_chunks (
        id, source_version_id, locator, content_hash, text, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const chunk of chunks) {
      insert.run(
        randomUUID(),
        sourceVersionId,
        chunk.locator,
        hashContent(chunk.text),
        chunk.text,
        JSON.stringify(chunk.metadata ?? {}),
        now,
      );
    }
  }

  private resolveChunks(input: KnowledgeSourceInput): KnowledgeChunkInput[] {
    if (input.chunks?.length) {
      return input.chunks;
    }
    const locatorBase = input.uri ?? input.name;
    return chunkExtractedDocument(locatorBase, input.content, DEFAULT_CHUNK_SIZE);
  }

  private getSourceRow(sourceId: string): { id: string } | undefined {
    return this.db
      .prepare(`SELECT id FROM core_knowledge_sources WHERE id = ?`)
      .get(sourceId) as { id: string } | undefined;
  }

  private resolveSourceId(input: KnowledgeSourceInput): string {
    if (input.id) {
      return input.id;
    }
    const existing = this.db
      .prepare(
        `SELECT id FROM core_knowledge_sources
         WHERE name = ? AND source_kind = ?`,
      )
      .get(input.name, input.sourceKind) as { id: string } | undefined;
    return existing?.id ?? randomUUID();
  }

  private getCurrentVersion(sourceId: string): VersionRow | undefined {
    return this.db
      .prepare(
        `SELECT version.id, version.version, version.content_hash, version.asset_version_id
         FROM core_knowledge_sources source
         INNER JOIN core_knowledge_source_versions version
           ON version.id = source.current_version_id
         WHERE source.id = ?`,
      )
      .get(sourceId) as VersionRow | undefined;
  }

  private requireAssetVersion(assetVersionId: string | null): {
    id: string;
    asset_id: string;
    version: number;
  } {
    if (!assetVersionId) {
      throw new Error("knowledge version is missing asset_version_id");
    }
    const row = this.db
      .prepare(`SELECT id, asset_id, version FROM core_asset_versions WHERE id = ?`)
      .get(assetVersionId) as
      | { id: string; asset_id: string; version: number }
      | undefined;
    if (!row) {
      throw new Error(`asset version not found: ${assetVersionId}`);
    }
    return row;
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function knowledgeAssetId(sourceId: string): string {
  return `knowledge:${sourceId}`;
}

function matchesScope(
  accessScopeJson: string,
  requested?: KnowledgeAccessScope,
): boolean {
  const stored = JSON.parse(accessScopeJson) as KnowledgeAccessScope;
  if (!hasScopeConstraints(stored)) {
    return true;
  }
  if (!requested) {
    return true;
  }
  if (stored.companyId && stored.companyId !== requested.companyId) {
    return false;
  }
  if (stored.projectId && stored.projectId !== requested.projectId) {
    return false;
  }
  if (stored.teamId && stored.teamId !== requested.teamId) {
    return false;
  }
  return true;
}

function hasScopeConstraints(scope: KnowledgeAccessScope): boolean {
  return Boolean(scope.companyId || scope.projectId || scope.teamId);
}

function scoreChunk(text: string, query: string): number {
  const haystack = text.toLowerCase();
  if (haystack.includes(query)) {
    return 1;
  }
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return 0;
  }
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  return matched / tokens.length;
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

interface VersionRow {
  id: string;
  version: number;
  content_hash: string;
  asset_version_id: string | null;
}

interface SearchRow {
  chunk_id: string;
  text: string;
  locator: string;
  content_hash: string;
  source_id: string;
  source_version_id: string;
  access_scope_json: string;
}

interface CitationRow {
  chunk_id: string;
  text: string;
  locator: string;
  content_hash: string;
  source_id: string;
  source_version_id: string;
}

export type { AssetVersionRef };
