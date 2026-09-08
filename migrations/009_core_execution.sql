CREATE TABLE IF NOT EXISTS core_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (
    state IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')
  ),
  spec_json TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  requested_by_json TEXT NOT NULL,
  acting_subject_json TEXT,
  objective TEXT,
  budget_account_id TEXT,
  policy_context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_steps (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'pending',
      'runnable',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'skipped',
      'cancelled'
    )
  ),
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  input_json TEXT NOT NULL DEFAULT '{}',
  workspace_binding_id TEXT,
  idempotency_key TEXT,
  retry_json TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id) REFERENCES core_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS core_step_dependencies (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  depends_on_step_id TEXT NOT NULL,
  PRIMARY KEY (run_id, step_id, depends_on_step_id),
  FOREIGN KEY (run_id, step_id) REFERENCES core_steps(run_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS core_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'created',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'abandoned',
      'cancelled'
    )
  ),
  worker_id TEXT,
  idempotency_key TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_ref TEXT,
  error_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id, step_id) REFERENCES core_steps(run_id, id) ON DELETE CASCADE,
  UNIQUE (run_id, step_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS core_step_waits (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  wait_kind TEXT NOT NULL,
  wait_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('waiting', 'resolved', 'expired', 'cancelled')
  ),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (run_id, step_id) REFERENCES core_steps(run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id) REFERENCES core_attempts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS core_idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  result_ref TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES core_attempts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_core_runs_state
  ON core_runs(state, updated_at);

CREATE INDEX IF NOT EXISTS idx_core_steps_run_state
  ON core_steps(run_id, state);

CREATE INDEX IF NOT EXISTS idx_core_attempts_run_step
  ON core_attempts(run_id, step_id, state);
