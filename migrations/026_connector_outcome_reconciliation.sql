ALTER TABLE core_connector_actions ADD COLUMN budget_reservation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_core_connector_actions_unknown
  ON core_connector_actions(state, updated_at)
  WHERE state = 'unknown';
