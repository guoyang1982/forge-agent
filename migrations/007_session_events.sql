CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_index INTEGER,
  event_type TEXT NOT NULL,
  item_id TEXT,
  payload TEXT NOT NULL,
  emitted_at_ms INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_session_events_session_seq
  ON session_events(session_id, id);
