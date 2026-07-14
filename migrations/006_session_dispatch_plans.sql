-- Structured coordinator dispatch plans for session timeline restore.
-- turn_index = 0-based ordinal among user messages (same as workspace_checkpoints).
CREATE TABLE IF NOT EXISTS session_dispatch_plans (
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_session_dispatch_plans_session
  ON session_dispatch_plans(session_id, turn_index);
