CREATE TABLE IF NOT EXISTS core_workspaces (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  canonical_root_path TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_workspace_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_workspace_bindings (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_path TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
  path_scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES core_workspace_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES core_workspaces(id) ON DELETE CASCADE,
  UNIQUE (group_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS core_workspace_leases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT,
  attempt_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
  root_path TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  released_reason TEXT,
  FOREIGN KEY (workspace_id) REFERENCES core_workspaces(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_core_workspace_active_write_lease
  ON core_workspace_leases(workspace_id)
  WHERE mode = 'write' AND released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_core_workspace_leases_run
  ON core_workspace_leases(run_id, acquired_at);

CREATE TABLE IF NOT EXISTS core_workspace_composite_checkpoints (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES core_workspace_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_core_workspace_composite_checkpoints_group
  ON core_workspace_composite_checkpoints(group_id, captured_at);
