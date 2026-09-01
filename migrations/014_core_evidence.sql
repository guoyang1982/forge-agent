CREATE TABLE IF NOT EXISTS core_artifacts (
  id TEXT PRIMARY KEY,
  producer_run_id TEXT NOT NULL,
  producer_step_id TEXT,
  media_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  access_scope_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_core_artifacts_run
  ON core_artifacts(producer_run_id, created_at);

CREATE TABLE IF NOT EXISTS core_evidence (
  id TEXT PRIMARY KEY,
  artifact_id TEXT,
  run_id TEXT,
  claim TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  sha256 TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES core_artifacts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_core_evidence_run
  ON core_evidence(run_id, created_at);

CREATE TABLE IF NOT EXISTS core_validations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  delivery_id TEXT,
  validator_id TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('result', 'process', 'answer')),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'inconclusive')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_core_validations_run
  ON core_validations(run_id, layer, created_at);
