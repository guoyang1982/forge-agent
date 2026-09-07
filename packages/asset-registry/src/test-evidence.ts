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
    ) VALUES (?, 'human', 'local', ?, 'asset.publish', 'asset', ?, 'allow', NULL, NULL, ?)`,
  ).run(
    input.grantId,
    policyVersionId,
    JSON.stringify({ resourceIds: [input.assetId, input.assetVersionId] }),
    now,
  );

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
        subjectKind: "human",
        subjectId: "local",
        action: "asset.publish",
        validatorId: "quality-gate",
        validationType: "publish",
        status: "passed",
        policyVersionId,
      }),
      now,
    );
  }
}

export function seedRollbackGrant(
  db: Database,
  grantId: string,
  assetId: string,
  targetVersionId: string,
): void {
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
    ) VALUES (?, 'human', 'local', ?, 'asset.rollback', 'asset', ?, 'allow', NULL, NULL, ?)`,
  ).run(
    grantId,
    policyVersionId,
    JSON.stringify({ resourceIds: [assetId, targetVersionId] }),
    now,
  );
}

export function seedWorkflowReplayGrant(
  db: Database,
  grantId: string,
  options: {
    subject?: { kind: string; id: string };
    workflowId?: string;
    instanceId?: string;
    action?: string;
    resourceKind?: string;
    policyActive?: boolean;
    expiresAt?: string | null;
  } = {},
): void {
  const now = new Date().toISOString();
  const subject = options.subject ?? { kind: "human", id: "operator-1" };
  const policyVersionId = `policy:test:${grantId}`;
  db.prepare(
    `INSERT OR IGNORE INTO core_policy_versions (
      id, name, version, rules_json, is_active, created_at
    ) VALUES (?, ?, 1, '{}', ?, ?)`,
  ).run(policyVersionId, `test-policy-${grantId}`, options.policyActive === false ? 0 : 1, now);
  db.prepare(
    `INSERT OR IGNORE INTO core_subjects (
      kind, subject_id, display_name, created_at, updated_at
    ) VALUES (?, ?, 'Operator', ?, ?)`,
  ).run(subject.kind, subject.id, now, now);
  db.prepare(
    `INSERT OR REPLACE INTO core_grants (
      id, subject_kind, subject_id, policy_version_id, action, resource_kind,
      resource_scope_json, effect, approval_class, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'allow', NULL, ?, ?)`,
  ).run(
    grantId,
    subject.kind,
    subject.id,
    policyVersionId,
    options.action ?? "workflow.replay",
    options.resourceKind ?? "workflow_instance",
    JSON.stringify({
      resourceIds: [options.workflowId ?? "wf-1", options.instanceId ?? "missing-instance"],
    }),
    options.expiresAt ?? null,
    now,
  );
}
