import type { Database } from "@forge/store";

export interface SeedPublishEvidenceInput {
  grantId: string;
  validationIds: string[];
  securityValidationId: string;
  assetId?: string;
  assetVersionId?: string;
  policyVersionId?: string;
}

export function seedPublishEvidence(
  db: Database,
  input: SeedPublishEvidenceInput,
): void {
  const now = new Date().toISOString();
  const policyVersionId = input.policyVersionId ?? "policy:test:v1";
  db.prepare(
    `INSERT OR IGNORE INTO core_policy_versions (
      id, name, version, rules_json, is_active, created_at
    ) VALUES (?, 'test-policy', 1, '{}', 1, ?)`,
  ).run(policyVersionId, now);
  db.prepare(
    `INSERT OR IGNORE INTO core_subjects (
      kind, subject_id, display_name, created_at, updated_at
    ) VALUES ('human', 'local', 'Local User', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT OR REPLACE INTO core_grants (
      id, subject_kind, subject_id, policy_version_id, action, resource_kind,
      resource_scope_json, effect, approval_class, expires_at, created_at
    ) VALUES (?, 'human', 'local', ?, 'asset.publish', 'asset', '{}', 'allow', NULL, NULL, ?)`,
  ).run(input.grantId, policyVersionId, now);

  const allValidationIds = new Set([
    ...input.validationIds,
    input.securityValidationId,
  ]);
  for (const validationId of allValidationIds) {
    db.prepare(
      `INSERT OR REPLACE INTO core_validations (
        id, run_id, delivery_id, validator_id, layer, status, severity,
        evidence_ids_json, summary, details_json, created_at
      ) VALUES (?, 'publish-gate', ?, 'quality-gate', 'result', 'passed', 'info', '[]', 'passed', ?, ?)`,
    ).run(
      validationId,
      input.assetId ?? "asset-draft",
      JSON.stringify({
        assetId: input.assetId,
        assetVersionId: input.assetVersionId,
        validatorId: "quality-gate",
        validationType: "publish",
        status: "passed",
        policyVersionId,
      }),
      now,
    );
  }
}

export function seedRollbackGrant(db: Database, grantId: string): void {
  const now = new Date().toISOString();
  const policyVersionId = "policy:test:v1";
  db.prepare(
    `INSERT OR IGNORE INTO core_policy_versions (
      id, name, version, rules_json, is_active, created_at
    ) VALUES (?, 'test-policy', 1, '{}', 1, ?)`,
  ).run(policyVersionId, now);
  db.prepare(
    `INSERT OR IGNORE INTO core_subjects (
      kind, subject_id, display_name, created_at, updated_at
    ) VALUES ('human', 'local', 'Local User', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT OR REPLACE INTO core_grants (
      id, subject_kind, subject_id, policy_version_id, action, resource_kind,
      resource_scope_json, effect, approval_class, expires_at, created_at
    ) VALUES (?, 'human', 'local', ?, 'asset.rollback', 'asset', '{}', 'allow', NULL, NULL, ?)`,
  ).run(grantId, policyVersionId, now);
}

export function seedWorkflowReplayGrant(db: Database, grantId: string): void {
  const now = new Date().toISOString();
  const policyVersionId = "policy:test:v1";
  db.prepare(
    `INSERT OR IGNORE INTO core_policy_versions (
      id, name, version, rules_json, is_active, created_at
    ) VALUES (?, 'test-policy', 1, '{}', 1, ?)`,
  ).run(policyVersionId, now);
  db.prepare(
    `INSERT OR IGNORE INTO core_subjects (
      kind, subject_id, display_name, created_at, updated_at
    ) VALUES ('human', 'operator-1', 'Operator', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT OR REPLACE INTO core_grants (
      id, subject_kind, subject_id, policy_version_id, action, resource_kind,
      resource_scope_json, effect, approval_class, expires_at, created_at
    ) VALUES (?, 'human', 'operator-1', ?, 'workflow.replay', 'workflow', '{}', 'allow', NULL, NULL, ?)`,
  ).run(grantId, policyVersionId, now);
}
