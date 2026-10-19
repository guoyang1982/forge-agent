import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Clock } from "../clock.js";
import type { FeedbackItem, ReleaseCandidate } from "./types.js";

export interface CreateReleaseCandidateInput {
  companyId: string;
  projectId: string;
  checkpointId: string;
  checkpointHash: string;
  artifactIds: string[];
  validationIds: string[];
  rollbackPlanArtifactId: string;
}

export interface ApproveReleaseCandidateInput {
  candidateId: string;
  approvalId: string;
  checkpointHash: string;
}

export interface RecordDeliveryReviewInput {
  candidateId: string;
  escapedDefects: string[];
  summary?: string;
  metrics?: Record<string, unknown>;
}

export interface DeliveryReview {
  candidateId: string;
  escapedDefects: string[];
  feedbackItemIds: string[];
  summary?: string;
  metrics: Record<string, unknown>;
}

type CandidateRow = {
  id: string;
  company_id: string;
  project_id: string;
  checkpoint_id: string;
  checkpoint_hash: string;
  artifact_ids_json: string;
  validation_ids_json: string;
  rollback_plan_artifact_id: string;
  approval_id: string | null;
  state: ReleaseCandidate["state"];
  candidate_hash: string;
  approval_candidate_hash: string | null;
  approval_checkpoint_hash: string | null;
  created_at: string;
  updated_at: string;
};

export class ReleaseService {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  createCandidate(input: CreateReleaseCandidateInput): ReleaseCandidate {
    requireText(input.companyId, "company required");
    requireText(input.projectId, "project required");
    requireText(input.checkpointId, "checkpoint required");
    requireText(input.checkpointHash, "checkpoint hash required");
    requireText(input.rollbackPlanArtifactId, "rollback plan artifact required");
    if (input.artifactIds.length === 0) {
      throw new Error("release artifacts required");
    }
    this.requireRollbackArtifact(input.companyId, input.rollbackPlanArtifactId);

    const id = randomUUID();
    const now = this.clock.now();
    const artifactIds = uniqueSorted(input.artifactIds);
    const validationIds = uniqueSorted(input.validationIds);
    const candidateHash = hashCandidateInputs({
      checkpointId: input.checkpointId,
      checkpointHash: input.checkpointHash,
      artifactIds,
      artifactContentHashes: this.artifactContentHashes(
        input.companyId,
        artifactIds,
      ),
      rollbackPlanArtifactId: input.rollbackPlanArtifactId,
    });
    this.db
      .prepare(
        `INSERT INTO company_release_candidates (
          id, company_id, project_id, checkpoint_id, checkpoint_hash,
          artifact_ids_json, validation_ids_json, rollback_plan_artifact_id,
          state, candidate_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .run(
        id,
        input.companyId,
        input.projectId,
        input.checkpointId,
        input.checkpointHash,
        JSON.stringify(artifactIds),
        JSON.stringify(validationIds),
        input.rollbackPlanArtifactId,
        candidateHash,
        now,
        now,
      );
    return this.getRequired(id);
  }

  submitForApproval(id: string): ReleaseCandidate {
    const row = this.getRow(id);
    if (row.state !== "draft" && row.state !== "validating") {
      throw new Error("candidate cannot be submitted for approval");
    }
    if (parseIds(row.validation_ids_json).length === 0) {
      throw new Error("delivery validations required");
    }
    this.assertValidationEvidence(row);
    this.updateState(id, "waiting_approval");
    return this.getRequired(id);
  }

  approve(input: ApproveReleaseCandidateInput): ReleaseCandidate {
    requireText(input.approvalId, "approval required");
    const row = this.getRow(input.candidateId);
    if (row.state !== "waiting_approval") {
      throw new Error("candidate is not waiting for approval");
    }
    const currentHash = this.candidateHashFromRow(row);
    if (currentHash !== row.candidate_hash) {
      throw new Error("candidate inputs changed");
    }
    if (input.checkpointHash !== row.checkpoint_hash) {
      throw new Error("checkpoint changed");
    }
    this.assertValidationEvidence(row);
    this.assertHighRiskApproval(input.approvalId, row, currentHash);
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE company_release_candidates
            SET approval_id = ?, approval_candidate_hash = ?,
                approval_checkpoint_hash = ?, state = 'approved', updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.approvalId,
        currentHash,
        input.checkpointHash,
        now,
        input.candidateId,
      );
    return this.getRequired(input.candidateId);
  }

  reject(id: string): ReleaseCandidate {
    const row = this.getRow(id);
    if (row.state === "released") {
      throw new Error("released candidate cannot be rejected");
    }
    this.updateState(id, "rejected");
    return this.getRequired(id);
  }

  release(id: string, connectorActionId?: string): ReleaseCandidate {
    const row = this.getRow(id);
    if (row.state !== "approved") {
      throw new Error("candidate is not approved");
    }
    if (
      this.candidateHashFromRow(row) !== row.approval_candidate_hash ||
      row.checkpoint_hash !== row.approval_checkpoint_hash
    ) {
      throw new Error("approval invalidated");
    }
    this.assertValidationEvidence(row);
    if (!connectorActionId) throw new Error("deployment receipt required");
    this.assertDeploymentReceipt(row, connectorActionId);
    this.updateState(id, "released");
    return this.getRequired(id);
  }

  recordReview(input: RecordDeliveryReviewInput): DeliveryReview {
    const candidate = this.getRow(input.candidateId);
    const defects = uniqueSorted(
      input.escapedDefects.filter((defect) => defect.trim().length > 0),
    );
    const feedbackItemIds: string[] = [];
    const now = this.clock.now();
    this.db.transaction(() => {
      for (const defect of defects) {
        const item: FeedbackItem = {
          id: randomUUID(),
          companyId: candidate.company_id,
          projectId: candidate.project_id,
          releaseCandidateId: candidate.id,
          source: "release_review",
          summary: defect,
          detail: {
            reviewSummary: input.summary,
            metrics: input.metrics ?? {},
          },
          createdAt: now,
        };
        this.db
          .prepare(
            `INSERT INTO company_feedback_items (
              id, company_id, project_id, release_candidate_id, source,
              summary, detail_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            item.id,
            item.companyId,
            item.projectId,
            item.releaseCandidateId,
            item.source,
            item.summary,
            JSON.stringify(item.detail),
            item.createdAt,
          );
        feedbackItemIds.push(item.id);
      }
    })();
    return {
      candidateId: candidate.id,
      escapedDefects: defects,
      feedbackItemIds,
      summary: input.summary,
      metrics: input.metrics ?? {},
    };
  }

  validatedGateInputs(id: string): unknown {
    const row = this.getRow(id);
    if (row.state !== "waiting_approval" && row.state !== "approved") throw new Error("validated release candidate required");
    if (this.candidateHashFromRow(row) !== row.candidate_hash) throw new Error("candidate inputs changed");
    this.requireRollbackArtifact(row.company_id, row.rollback_plan_artifact_id);
    this.assertValidationEvidence(row);
    const artifacts = [...parseIds(row.artifact_ids_json), row.rollback_plan_artifact_id].map(id => {
      const artifact = this.db.prepare(`SELECT a.* FROM company_work_artifacts a JOIN company_work_items w ON w.id = a.work_item_id
        WHERE a.id = ? AND a.company_id = ? AND w.project_id = ?`).get(id, row.company_id, row.project_id);
      if (!artifact) throw new Error("release artifact outside project");
      return artifact;
    });
    const validations = parseIds(row.validation_ids_json).map(id => this.db.prepare("SELECT * FROM core_validations WHERE id = ?").get(id));
    return { row, artifacts, validations };
  }

  get(id: string): ReleaseCandidate | null {
    const row = this.db
      .prepare("SELECT * FROM company_release_candidates WHERE id = ?")
      .get(id) as CandidateRow | undefined;
    return row ? mapCandidate(row) : null;
  }

  private getRequired(id: string): ReleaseCandidate {
    const candidate = this.get(id);
    if (!candidate) throw new Error("release candidate not found");
    return candidate;
  }

  private getRow(id: string): CandidateRow {
    const row = this.db
      .prepare("SELECT * FROM company_release_candidates WHERE id = ?")
      .get(id) as CandidateRow | undefined;
    if (!row) throw new Error("release candidate not found");
    return row;
  }

  private updateState(id: string, state: ReleaseCandidate["state"]): void {
    this.db
      .prepare(
        "UPDATE company_release_candidates SET state = ?, updated_at = ? WHERE id = ?",
      )
      .run(state, this.clock.now(), id);
  }

  private assertDeploymentReceipt(row: CandidateRow, actionId: string): void {
    const receipt = this.db.prepare(`SELECT action, state, proposal_json AS proposal, result_json AS result
      FROM core_connector_actions WHERE id = ?`).get(actionId) as
      { action: string; state: string; proposal: string; result: string | null } | undefined;
    if (!receipt || receipt.action !== "deploy" || receipt.state !== "succeeded") {
      throw new Error("successful deployment receipt required");
    }
    const proposal = JSON.parse(receipt.proposal);
    const result = JSON.parse(receipt.result || "null");
    if (proposal?.companyId !== row.company_id || proposal?.projectId !== row.project_id ||
        proposal?.candidateId !== row.id || proposal?.candidateHash !== row.approval_candidate_hash ||
        proposal?.checkpointHash !== row.approval_checkpoint_hash || result?.ok !== true ||
        typeof result.externalId !== "string" || !result.externalId.trim()) {
      throw new Error("deployment receipt mismatch");
    }
  }

  private assertValidationEvidence(row: CandidateRow): void {
    const validations = parseIds(row.validation_ids_json).map((id) =>
      this.db.prepare(`SELECT delivery_id AS deliveryId, run_id AS runId, layer, status, details_json AS details
        FROM core_validations WHERE id = ?`).get(id) as
        { deliveryId: string; runId: string; layer: string; status: string; details: string } | undefined,
    );
    if (validations.some((v) => !v || v.deliveryId !== row.project_id || v.status !== "passed") ||
        new Set(validations.map((v) => v?.runId)).size !== 1 ||
        !["result", "process", "answer"].every((layer) => validations.some((v) => v?.layer === layer))) {
      throw new Error("delivery validation evidence invalid");
    }
    const ids = uniqueSorted(parseIds(row.artifact_ids_json));
    for (const validation of validations) {
      const binding = JSON.parse(validation!.details)?.inputBinding;
      if (!binding || binding.checkpointId !== row.checkpoint_id ||
          binding.checkpointHash !== row.checkpoint_hash ||
          JSON.stringify(binding.artifactIds) !== JSON.stringify(ids) ||
          ids.some((id) => {
            const artifact = this.db.prepare("SELECT content_hash AS hash FROM company_work_artifacts WHERE company_id = ? AND id = ?")
              .get(row.company_id, id) as { hash: string } | undefined;
            return !artifact || binding.artifactHashes?.[id] !== artifact.hash;
          })) throw new Error("delivery validation version mismatch");
    }
  }

  private requireRollbackArtifact(companyId: string, artifactId: string): void {
    const artifact = this.db
      .prepare(
        `SELECT id FROM company_work_artifacts
          WHERE company_id = ? AND id = ? AND kind = 'plan'`,
      )
      .get(companyId, artifactId);
    if (!artifact) throw new Error("rollback plan artifact not found");
  }

  private candidateHashFromRow(row: CandidateRow): string {
    const artifactIds = parseIds(row.artifact_ids_json);
    return hashCandidateInputs({
      checkpointId: row.checkpoint_id,
      checkpointHash: row.checkpoint_hash,
      artifactIds,
      artifactContentHashes: this.artifactContentHashes(
        row.company_id,
        artifactIds,
      ),
      rollbackPlanArtifactId: row.rollback_plan_artifact_id,
    });
  }

  private artifactContentHashes(
    companyId: string,
    artifactIds: string[],
  ): string[] {
    return artifactIds.map((artifactId) => {
      const artifact = this.db
        .prepare(
          `SELECT content_hash AS contentHash
             FROM company_work_artifacts
            WHERE company_id = ? AND id = ?`,
        )
        .get(companyId, artifactId) as { contentHash: string } | undefined;
      return `${artifactId}:${artifact?.contentHash ?? "missing"}`;
    });
  }

  private assertHighRiskApproval(
    approvalId: string,
    row: CandidateRow,
    candidateHash: string,
  ): void {
    const approval = this.db
      .prepare(
        `SELECT state, risk, resource_id AS resourceId,
                parameters_hash AS parametersHash, expires_at AS expiresAt
           FROM core_approvals
          WHERE id = ?`,
      )
      .get(approvalId) as
      | {
          state: string;
          risk: string;
          resourceId: string;
          parametersHash: string;
          expiresAt: string;
        }
      | undefined;
    if (!approval) throw new Error("approval not found");
    if (approval.state !== "approved") throw new Error("approval not approved");
    if (approval.risk !== "high" && approval.risk !== "critical") {
      throw new Error("approval not high risk");
    }
    if (approval.resourceId !== row.id) {
      throw new Error("approval resource mismatch");
    }
    if (approval.expiresAt <= this.clock.now()) {
      throw new Error("approval expired");
    }
    if (approval.parametersHash !== candidateHash) {
      throw new Error("approval hash mismatch");
    }
  }
}

function mapCandidate(row: CandidateRow): ReleaseCandidate {
  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    checkpointId: row.checkpoint_id,
    artifactIds: parseIds(row.artifact_ids_json),
    validationIds: parseIds(row.validation_ids_json),
    rollbackPlanArtifactId: row.rollback_plan_artifact_id,
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hashCandidateInputs(input: {
  checkpointId: string;
  checkpointHash: string;
  artifactIds: string[];
  artifactContentHashes: string[];
  rollbackPlanArtifactId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        checkpointId: input.checkpointId,
        checkpointHash: input.checkpointHash,
        artifactIds: uniqueSorted(input.artifactIds),
        artifactContentHashes: uniqueSorted(input.artifactContentHashes),
        rollbackPlanArtifactId: input.rollbackPlanArtifactId,
      }),
    )
    .digest("hex");
}

function parseIds(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed)
    ? parsed.filter((id): id is string => typeof id === "string")
    : [];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function requireText(value: string, message: string): void {
  if (!value.trim()) throw new Error(message);
}
