ALTER TABLE automation_runs ADD COLUMN trigger_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_run_occurrence
  ON automation_runs(automation_id, trigger_ref)
  WHERE trigger_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS core_legacy_run_results (
  output_ref TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  final_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
