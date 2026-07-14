-- Per-turn worktree snapshots for rewind. turn_index = count of user
-- messages at snapshot time (the 0-based ordinal of the upcoming turn).
CREATE TABLE IF NOT EXISTS workspace_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  sha TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_checkpoints_session
  ON workspace_checkpoints(session_id, turn_index);
