CREATE TABLE IF NOT EXISTS core_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  run_id TEXT,
  step_id TEXT,
  attempt_id TEXT,
  correlation_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_core_events_sequence
  ON core_events(sequence);

CREATE INDEX IF NOT EXISTS idx_core_events_run
  ON core_events(run_id, sequence);

CREATE INDEX IF NOT EXISTS idx_core_events_type
  ON core_events(event_type, sequence);

CREATE TABLE IF NOT EXISTS core_outbox (
  id TEXT PRIMARY KEY,
  event_sequence INTEGER NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  FOREIGN KEY (event_sequence) REFERENCES core_events(sequence)
);

CREATE INDEX IF NOT EXISTS idx_core_outbox_pending
  ON core_outbox(state, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS core_event_cursors (
  consumer_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_eval_suites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS core_eval_runs (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  suite_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  baseline_run_id TEXT,
  result_summary_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (suite_id) REFERENCES core_eval_suites(id)
);

CREATE TABLE IF NOT EXISTS core_eval_case_results (
  id TEXT PRIMARY KEY,
  eval_run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('passed', 'failed', 'skipped', 'error')
  ),
  score REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  trace_ref TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (eval_run_id) REFERENCES core_eval_runs(id) ON DELETE CASCADE,
  UNIQUE (eval_run_id, case_id)
);
