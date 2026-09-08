-- Older pending proposals have no trustworthy risk classification. They must be
-- proposed again with a new idempotency key before execution can be approved.
ALTER TABLE core_connector_actions ADD COLUMN preview_json TEXT;
