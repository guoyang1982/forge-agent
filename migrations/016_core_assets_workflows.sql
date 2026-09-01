CREATE TABLE IF NOT EXISTS core_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN ('skill', 'knowledge', 'agent_profile', 'workflow', 'position_template')
  ),
  name TEXT NOT NULL,
  owner_subject_kind TEXT NOT NULL,
  owner_subject_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('draft', 'testing', 'published', 'deprecated', 'rolled_back')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (
    state IN ('draft', 'testing', 'published', 'deprecated', 'rolled_back')
  ),
  owner_subject_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  validation_ids_json TEXT NOT NULL DEFAULT '[]',
  content_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES core_assets(id) ON DELETE CASCADE,
  UNIQUE (asset_id, version)
);

CREATE TABLE IF NOT EXISTS core_asset_dependencies (
  id TEXT PRIMARY KEY,
  asset_version_id TEXT NOT NULL,
  depends_on_asset_id TEXT NOT NULL,
  depends_on_version INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_version_id) REFERENCES core_asset_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_asset_id) REFERENCES core_assets(id),
  UNIQUE (asset_version_id, depends_on_asset_id, depends_on_version)
);

CREATE TABLE IF NOT EXISTS core_workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  asset_version_id TEXT,
  definition_json TEXT NOT NULL,
  input_schema_json TEXT NOT NULL DEFAULT '{}',
  triggers_json TEXT NOT NULL DEFAULT '[]',
  concurrency_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_version_id) REFERENCES core_asset_versions(id),
  UNIQUE (workflow_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_core_workflow_version
  ON core_workflow_versions(workflow_id, version);

CREATE TABLE IF NOT EXISTS core_workflow_instances (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version_id TEXT NOT NULL,
  run_id TEXT,
  state TEXT NOT NULL CHECK (
    state IN (
      'pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'dead_letter'
    )
  ),
  trigger_kind TEXT NOT NULL,
  trigger_ref TEXT,
  concurrency_key TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workflow_version_id) REFERENCES core_workflow_versions(id),
  FOREIGN KEY (run_id) REFERENCES core_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_core_workflow_instances_workflow
  ON core_workflow_instances(workflow_id, state, created_at);

CREATE INDEX IF NOT EXISTS idx_core_asset_versions_asset
  ON core_asset_versions(asset_id, version);
