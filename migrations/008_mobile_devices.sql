CREATE TABLE IF NOT EXISTS mobile_devices (
  adapter_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  display_name TEXT,
  token_hash BLOB NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  allowed_projects_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (adapter_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_mobile_devices_active
  ON mobile_devices(adapter_id, revoked_at);

CREATE TABLE IF NOT EXISTS mobile_pairing_journal (
  adapter_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  invite_id TEXT NOT NULL,
  display_name TEXT,
  pairing_secret_hash BLOB NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (adapter_id, device_id)
);

CREATE TABLE IF NOT EXISTS mobile_relay_outbox (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  device_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mobile_relay_outbox_pending
  ON mobile_relay_outbox(adapter_id, completed_at, created_at);
