CREATE TABLE IF NOT EXISTS core_agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_agent_profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  policy_version_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES core_agent_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (policy_version_id) REFERENCES core_policy_versions(id),
  UNIQUE (profile_id, version)
);

CREATE TABLE IF NOT EXISTS core_agent_capability_snapshots (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  profile_version_id TEXT NOT NULL,
  run_id TEXT,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES core_agent_profiles(id),
  FOREIGN KEY (profile_version_id) REFERENCES core_agent_profile_versions(id),
  UNIQUE (profile_version_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_core_agent_profile_versions_profile
  ON core_agent_profile_versions(profile_id, version);
