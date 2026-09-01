CREATE TABLE IF NOT EXISTS core_knowledge_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  uri TEXT,
  access_scope_json TEXT NOT NULL DEFAULT '{}',
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_knowledge_source_versions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  content_hash TEXT NOT NULL,
  asset_version_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES core_knowledge_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_version_id) REFERENCES core_asset_versions(id),
  UNIQUE (source_id, version)
);

CREATE TABLE IF NOT EXISTS core_knowledge_chunks (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL,
  locator TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_version_id) REFERENCES core_knowledge_source_versions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_core_knowledge_chunks_source_version
  ON core_knowledge_chunks(source_version_id, locator);

CREATE TABLE IF NOT EXISTS core_memory_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}',
  claim TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL CHECK (
    decision IN ('pending', 'ADD', 'UPDATE', 'DELETE', 'NOOP')
  ),
  decided_at TEXT,
  expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_core_memory_candidates_run
  ON core_memory_candidates(run_id, decision, created_at);
