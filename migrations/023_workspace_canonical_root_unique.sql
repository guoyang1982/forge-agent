CREATE UNIQUE INDEX IF NOT EXISTS uq_core_workspace_canonical_root
  ON core_workspaces(canonical_root_path);
