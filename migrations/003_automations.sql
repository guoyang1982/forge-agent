CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  cwd TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  cron_expr TEXT,
  timezone TEXT,
  prompt TEXT NOT NULL,
  model TEXT,
  memory_enabled INTEGER NOT NULL DEFAULT 0,
  session_mode TEXT NOT NULL DEFAULT 'new',
  resume_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  next_run_at TEXT
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  preview TEXT,
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

CREATE INDEX IF NOT EXISTS idx_automations_enabled_cron
  ON automations(enabled, trigger_type);
CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
  ON automation_runs(automation_id, started_at DESC);
