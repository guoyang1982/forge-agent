CREATE TABLE IF NOT EXISTS channel_adapters (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  cwd TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  last_message_at TEXT
);

CREATE TABLE IF NOT EXISTS channel_bindings (
  channel TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  peer_user_id TEXT,
  peer_chat_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, thread_key)
);

CREATE INDEX IF NOT EXISTS idx_channel_adapters_enabled
  ON channel_adapters(enabled, kind);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_session
  ON channel_bindings(session_id);
