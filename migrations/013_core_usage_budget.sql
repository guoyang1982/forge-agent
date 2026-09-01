CREATE TABLE IF NOT EXISTS core_budget_accounts (
  id TEXT PRIMARY KEY,
  parent_account_id TEXT,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  hard_limit_minor INTEGER CHECK (
    hard_limit_minor IS NULL OR hard_limit_minor >= 0
  ),
  soft_limit_minor INTEGER CHECK (
    soft_limit_minor IS NULL OR soft_limit_minor >= 0
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (parent_account_id) REFERENCES core_budget_accounts(id)
);

CREATE TABLE IF NOT EXISTS core_budget_reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  committed_minor INTEGER CHECK (
    committed_minor IS NULL OR committed_minor >= 0
  ),
  currency TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  FOREIGN KEY (account_id) REFERENCES core_budget_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_core_budget_reservations_account_state
  ON core_budget_reservations(account_id, state, created_at);

CREATE TABLE IF NOT EXISTS core_usage_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  reservation_id TEXT,
  run_id TEXT,
  step_id TEXT,
  attempt_id TEXT,
  usage_kind TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES core_budget_accounts(id),
  FOREIGN KEY (reservation_id) REFERENCES core_budget_reservations(id)
);

CREATE INDEX IF NOT EXISTS idx_core_usage_entries_account
  ON core_usage_entries(account_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_core_usage_entries_run
  ON core_usage_entries(run_id, recorded_at);
