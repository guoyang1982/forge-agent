ALTER TABLE core_outbox ADD COLUMN leased_by TEXT;
ALTER TABLE core_outbox ADD COLUMN leased_until TEXT;

CREATE INDEX IF NOT EXISTS idx_core_outbox_leased
  ON core_outbox(destination, leased_until)
  WHERE state = 'pending' AND leased_by IS NOT NULL;
