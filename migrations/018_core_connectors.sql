CREATE TABLE IF NOT EXISTS core_connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter_kind TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_connector_accounts (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  name TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connector_id) REFERENCES core_connectors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS core_connector_actions (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  connector_account_id TEXT NOT NULL,
  action TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'proposed', 'approved', 'executing', 'succeeded', 'failed', 'unknown', 'reconciled'
    )
  ),
  idempotency_key TEXT NOT NULL,
  proposal_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  approval_id TEXT,
  run_id TEXT,
  step_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connector_id) REFERENCES core_connectors(id),
  FOREIGN KEY (connector_account_id) REFERENCES core_connector_accounts(id),
  FOREIGN KEY (approval_id) REFERENCES core_approvals(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_core_connector_action_idempotency
  ON core_connector_actions(connector_account_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_core_connector_actions_state
  ON core_connector_actions(connector_account_id, state, created_at);
