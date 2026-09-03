ALTER TABLE core_approvals ADD COLUMN consumed_at TEXT;

CREATE TABLE IF NOT EXISTS core_workflow_dead_letter_replays (
  dead_letter_instance_id TEXT PRIMARY KEY,
  replay_instance_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (dead_letter_instance_id) REFERENCES core_workflow_instances(id)
);
