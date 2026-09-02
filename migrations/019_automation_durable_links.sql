ALTER TABLE automation_runs ADD COLUMN workflow_instance_id TEXT
  REFERENCES core_workflow_instances(id);

ALTER TABLE automation_runs ADD COLUMN durable_run_id TEXT
  REFERENCES core_runs(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_core_workflow_occurrence
  ON core_workflow_instances(workflow_id, trigger_ref)
  WHERE trigger_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_runs_durable_run
  ON automation_runs(durable_run_id);
