CREATE TABLE IF NOT EXISTS core_subjects (
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  display_name TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, subject_id)
);

CREATE TABLE IF NOT EXISTS core_policy_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  rules_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS core_grants (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_scope_json TEXT NOT NULL DEFAULT '{}',
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny', 'require_approval')),
  approval_class TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (subject_kind, subject_id) REFERENCES core_subjects(kind, subject_id),
  FOREIGN KEY (policy_version_id) REFERENCES core_policy_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_core_grants_subject
  ON core_grants(subject_kind, subject_id, action);

CREATE TABLE IF NOT EXISTS core_approvals (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  parameters_hash TEXT NOT NULL,
  parameters_summary TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  estimated_cost_minor INTEGER CHECK (
    estimated_cost_minor IS NULL OR estimated_cost_minor >= 0
  ),
  policy_version_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'approved', 'denied', 'expired', 'revoked')
  ),
  run_id TEXT,
  step_id TEXT,
  attempt_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (policy_version_id) REFERENCES core_policy_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_core_approvals_pending
  ON core_approvals(state, expires_at);

CREATE TABLE IF NOT EXISTS core_approval_decisions (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL UNIQUE,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT,
  decided_at TEXT NOT NULL,
  FOREIGN KEY (approval_id) REFERENCES core_approvals(id) ON DELETE CASCADE
);
