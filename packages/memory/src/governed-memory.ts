import { randomUUID } from "node:crypto";
import type { Database } from "@forge/store";

export type MemoryDecision = "ADD" | "UPDATE" | "DELETE" | "NOOP";

export interface MemoryScope {
  companyId?: string;
  employeeId?: string;
  projectId?: string;
  shared?: boolean;
}

export interface MemoryCandidateInput {
  claim: string;
  scope: MemoryScope;
  sourceKind: string;
  sourceRef: string;
  evidenceIds?: string[];
  runId?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  redacted?: boolean;
  targetMemoryId?: string;
}

export interface MemoryCandidateRecord {
  id: string;
  claim: string;
  scope: MemoryScope;
  sourceKind: string;
  sourceRef: string;
  evidenceIds: string[];
  decision: MemoryDecision | "pending";
  createdAt: string;
  decidedAt?: string;
  expiresAt?: string;
  memoryId?: string;
  version: number;
}

export interface DecideInput {
  candidateId: string;
  decision: MemoryDecision;
  memoryId?: string;
  decidedAt?: string;
}

export interface RecallContext {
  companyId: string;
  employeeId: string;
  projectId?: string;
  query?: string;
  limit?: number;
  now?: string;
}

export interface RecalledMemory {
  memoryId: string;
  versionId: string;
  content: string;
  sourceRefs: string[];
  confidence: number;
  reasonRecalled: string;
}

interface CandidateRow {
  id: string;
  run_id: string | null;
  scope_json: string;
  claim: string;
  source_kind: string;
  source_ref: string;
  evidence_ids_json: string;
  decision: string;
  decided_at: string | null;
  expires_at: string | null;
  metadata_json: string;
  created_at: string;
}

const SHARED_CONVERSATION_KINDS = new Set([
  "conversation",
  "raw_conversation",
  "cross_user_conversation",
]);

const RESERVED_METADATA_KEYS = new Set([
  "memoryId",
  "version",
  "superseded",
  "invalidated",
  "invalidatedAt",
  "redacted",
  "targetMemoryId",
]);

export class GovernedMemoryStore {
  constructor(private readonly db: Database) {}

  propose(input: MemoryCandidateInput): MemoryCandidateRecord {
    assertProposable(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const memoryId = input.targetMemoryId ?? id;
    const version = input.targetMemoryId
      ? this.nextVersionForMemory(memoryId)
      : 1;

    this.db
      .prepare(
        `INSERT INTO core_memory_candidates (
          id, run_id, scope_json, claim, source_kind, source_ref,
          evidence_ids_json, decision, decided_at, expires_at, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId ?? null,
        JSON.stringify(input.scope),
        input.claim,
        input.sourceKind,
        input.sourceRef,
        JSON.stringify(input.evidenceIds ?? []),
        input.expiresAt ?? null,
        JSON.stringify({
          memoryId,
          version,
          redacted: Boolean(input.redacted),
          targetMemoryId: input.targetMemoryId,
          ...sanitizeUserMetadata(input.metadata),
        }),
        now,
      );

    return this.getCandidate(id)!;
  }

  decide(input: DecideInput): MemoryCandidateRecord {
    const candidate = this.getCandidate(input.candidateId);
    if (!candidate) {
      throw new Error(`memory candidate not found: ${input.candidateId}`);
    }
    if (candidate.decision !== "pending") {
      throw new Error(`memory candidate already decided: ${input.candidateId}`);
    }

    const decidedAt = input.decidedAt ?? new Date().toISOString();
    const metadata = this.getMetadata(input.candidateId);
    const memoryId = String(
      input.memoryId ?? metadata.memoryId ?? input.candidateId,
    );

    if (input.decision === "UPDATE") {
      this.markSuperseded(memoryId, input.candidateId);
    }
    if (input.decision === "DELETE") {
      this.markInvalidated(memoryId, decidedAt);
    }

    const storedDecision =
      input.decision === "UPDATE" ? "ADD" : input.decision;

    const result = this.db
      .prepare(
        `UPDATE core_memory_candidates
         SET decision = ?, decided_at = ?, metadata_json = ?
         WHERE id = ? AND decision = 'pending'`,
      )
      .run(
        storedDecision,
        decidedAt,
        JSON.stringify({
          ...metadata,
          memoryId,
          superseded: false,
          invalidated: input.decision === "DELETE",
        }),
        input.candidateId,
      );
    if (result.changes !== 1) {
      throw new Error(`memory candidate already decided: ${input.candidateId}`);
    }

    return this.getCandidate(input.candidateId)!;
  }

  recall(context: RecallContext): RecalledMemory[] {
    const now = context.now ?? new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, run_id, scope_json, claim, source_kind, source_ref,
                evidence_ids_json, decision, decided_at, expires_at, metadata_json, created_at
         FROM core_memory_candidates
         WHERE decision = 'ADD'
         ORDER BY decided_at DESC`,
      )
      .all() as CandidateRow[];

    return rows
      .filter((row) => isActiveRow(row, now))
      .filter((row) => matchesRecallScope(parseScope(row.scope_json), context))
      .filter((row) => matchesQuery(row.claim, context.query))
      .map((row) => toRecalledMemory(row))
      .slice(0, context.limit ?? 20);
  }

  invalidate(memoryId: string, invalidatedAt = new Date().toISOString()): void {
    this.markInvalidated(memoryId, invalidatedAt);
  }

  getCandidate(id: string): MemoryCandidateRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id, scope_json, claim, source_kind, source_ref,
                evidence_ids_json, decision, decided_at, expires_at, metadata_json, created_at
         FROM core_memory_candidates
         WHERE id = ?`,
      )
      .get(id) as CandidateRow | undefined;
    return row ? mapCandidate(row) : null;
  }

  private nextVersionForMemory(memoryId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(CAST(json_extract(metadata_json, '$.version') AS INTEGER)), 0) AS maxVersion
         FROM core_memory_candidates
         WHERE json_extract(metadata_json, '$.memoryId') = ?`,
      )
      .get(memoryId) as { maxVersion: number };
    return row.maxVersion + 1;
  }

  private markSuperseded(memoryId: string, exceptCandidateId: string): void {
    const rows = this.db
      .prepare(
        `SELECT id, metadata_json
         FROM core_memory_candidates
         WHERE decision = 'ADD'
           AND json_extract(metadata_json, '$.memoryId') = ?
           AND id != ?`,
      )
      .all(memoryId, exceptCandidateId) as Array<{
      id: string;
      metadata_json: string;
    }>;

    const update = this.db.prepare(
      `UPDATE core_memory_candidates SET metadata_json = ? WHERE id = ?`,
    );
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      update.run(JSON.stringify({ ...metadata, superseded: true }), row.id);
    }
  }

  private markInvalidated(memoryId: string, invalidatedAt: string): void {
    const rows = this.db
      .prepare(
        `SELECT id, metadata_json
         FROM core_memory_candidates
         WHERE json_extract(metadata_json, '$.memoryId') = ?`,
      )
      .all(memoryId) as Array<{ id: string; metadata_json: string }>;

    const update = this.db.prepare(
      `UPDATE core_memory_candidates
       SET metadata_json = ?, decision = CASE WHEN decision = 'ADD' THEN 'DELETE' ELSE decision END,
           decided_at = COALESCE(decided_at, ?)
       WHERE id = ?`,
    );
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      update.run(
        JSON.stringify({ ...metadata, invalidated: true, invalidatedAt }),
        invalidatedAt,
        row.id,
      );
    }
  }

  private getMetadata(candidateId: string): Record<string, unknown> {
    const row = this.db
      .prepare(`SELECT metadata_json FROM core_memory_candidates WHERE id = ?`)
      .get(candidateId) as { metadata_json: string } | undefined;
    return row ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {};
  }
}

function assertProposable(input: MemoryCandidateInput): void {
  if (!input.claim.trim()) {
    throw new Error("memory claim is required");
  }
  const sharedConversation =
    Boolean(input.scope.shared) &&
    SHARED_CONVERSATION_KINDS.has(input.sourceKind);
  if (sharedConversation && !input.redacted) {
    throw new Error("raw cross-user conversation must be redacted before propose");
  }
  if (sharedConversation && input.redacted && !(input.evidenceIds?.length ?? 0)) {
    throw new Error("redacted shared memory requires supporting evidence");
  }
}

function isActiveRow(row: CandidateRow, now: string): boolean {
  const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  if (metadata.superseded || metadata.invalidated) {
    return false;
  }
  if (row.expires_at && row.expires_at <= now) {
    return false;
  }
  return true;
}

function matchesRecallScope(scope: MemoryScope, context: RecallContext): boolean {
  if (scope.companyId && scope.companyId !== context.companyId) {
    return false;
  }
  if (!scope.shared && scope.employeeId && scope.employeeId !== context.employeeId) {
    return false;
  }
  if (scope.projectId) {
    if (!context.projectId || scope.projectId !== context.projectId) {
      return false;
    }
  }
  return true;
}

function sanitizeUserMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  if (!metadata) {
    return {};
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!RESERVED_METADATA_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function matchesQuery(claim: string, query?: string): boolean {
  if (!query?.trim()) {
    return true;
  }
  return claim.toLowerCase().includes(query.trim().toLowerCase());
}

function toRecalledMemory(row: CandidateRow): RecalledMemory {
  const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  const evidenceIds = JSON.parse(row.evidence_ids_json) as string[];
  const memoryId = String(metadata.memoryId ?? row.id);
  const version = Number(metadata.version ?? 1);
  return {
    memoryId,
    versionId: row.id,
    content: row.claim,
    sourceRefs: [row.source_ref, ...evidenceIds],
    confidence: Math.min(1, 0.6 + evidenceIds.length * 0.1),
    reasonRecalled: `approved memory v${version} matched recall scope`,
  };
}

function mapCandidate(row: CandidateRow): MemoryCandidateRecord {
  const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  return {
    id: row.id,
    claim: row.claim,
    scope: parseScope(row.scope_json),
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
    decision: row.decision as MemoryCandidateRecord["decision"],
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    memoryId: metadata.memoryId ? String(metadata.memoryId) : undefined,
    version: Number(metadata.version ?? 1),
  };
}

function parseScope(scopeJson: string): MemoryScope {
  return JSON.parse(scopeJson) as MemoryScope;
}
