ALTER TABLE core_idempotency_records
  ADD COLUMN state TEXT NOT NULL DEFAULT 'claimed';

ALTER TABLE core_idempotency_records
  ADD COLUMN updated_at TEXT;

UPDATE core_idempotency_records
SET state = CASE WHEN result_ref IS NULL THEN 'claimed' ELSE 'completed' END,
    updated_at = created_at;
