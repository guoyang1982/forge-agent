CREATE TABLE IF NOT EXISTS relay_hosts (
    host_id TEXT PRIMARY KEY,
    identity_public_key BYTEA NOT NULL,
    e2ee_public_key BYTEA NOT NULL,
    credential_hash BYTEA NOT NULL,
    credential_version INTEGER NOT NULL CHECK (credential_version > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS relay_devices (
    host_id TEXT NOT NULL REFERENCES relay_hosts(host_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    resume_token_hash BYTEA NOT NULL,
    credential_version INTEGER NOT NULL CHECK (credential_version > 0),
    expires_at TIMESTAMPTZ NOT NULL,
    grace_token_hash BYTEA,
    grace_expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (host_id, device_id)
);

CREATE TABLE IF NOT EXISTS relay_invites (
    invite_id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL REFERENCES relay_hosts(host_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    invite_token_hash BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS relay_invites_active_device_idx
    ON relay_invites (host_id, device_id)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS relay_audit_events (
    id BIGSERIAL PRIMARY KEY,
    host_id TEXT,
    device_id TEXT,
    event_type TEXT NOT NULL,
    result_code TEXT NOT NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS relay_audit_events_created_at_idx ON relay_audit_events (created_at);
