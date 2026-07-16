package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound          = errors.New("record not found")
	ErrCredential        = errors.New("credential rejected")
	ErrInviteUnavailable = errors.New("invite is expired, revoked, or consumed")
)

type Postgres struct{ pool *pgxpool.Pool }

type Host struct {
	HostID            string
	IdentityPublicKey []byte
	E2EEPublicKey     []byte
	CredentialVersion int
}

type Invite struct {
	InviteID    string
	InviteToken string
	DeviceID    string
	ExpiresAt   time.Time
}

type DeviceCredential struct {
	HostID   string
	DeviceID string
	Kind     string
	Version  int
}

func Open(ctx context.Context, databaseURL string) (*Postgres, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database URL: %w", err)
	}
	config.MaxConns = 10
	config.MinConns = 1
	config.MaxConnLifetime = 30 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	return &Postgres{pool: pool}, nil
}

func (s *Postgres) Close()                         { s.pool.Close() }
func (s *Postgres) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }
func (s *Postgres) Migrator() *Migrator            { return NewMigrator(s.pool) }

func (s *Postgres) EnrollHost(ctx context.Context, identityPublicKey, e2eePublicKey []byte) (Host, string, error) {
	hostID, err := randomCredential("host_", 18)
	if err != nil {
		return Host{}, "", err
	}
	credential, err := randomCredential("hostcred_", 32)
	if err != nil {
		return Host{}, "", err
	}
	host := Host{HostID: hostID, IdentityPublicKey: identityPublicKey, E2EEPublicKey: e2eePublicKey, CredentialVersion: 1}
	_, err = s.pool.Exec(ctx, `INSERT INTO relay_hosts
        (host_id, identity_public_key, e2ee_public_key, credential_hash, credential_version)
        VALUES ($1, $2, $3, $4, $5)`, host.HostID, identityPublicKey, e2eePublicKey, tokenHash(credential), host.CredentialVersion)
	if err != nil {
		return Host{}, "", fmt.Errorf("enroll host: %w", err)
	}
	return host, credential, nil
}

func (s *Postgres) AuthenticateHost(ctx context.Context, hostID, credential string) (Host, error) {
	var host Host
	var storedHash []byte
	var status string
	err := s.pool.QueryRow(ctx, `SELECT host_id, identity_public_key, e2ee_public_key, credential_hash, credential_version, status
        FROM relay_hosts WHERE host_id = $1`, hostID).Scan(
		&host.HostID, &host.IdentityPublicKey, &host.E2EEPublicKey, &storedHash, &host.CredentialVersion, &status,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Host{}, ErrCredential
	}
	if err != nil {
		return Host{}, err
	}
	actualHash := tokenHash(credential)
	if status != "active" || subtle.ConstantTimeCompare(storedHash, actualHash) != 1 {
		return Host{}, ErrCredential
	}
	return host, nil
}

func (s *Postgres) Host(ctx context.Context, hostID string) (Host, error) {
	var host Host
	err := s.pool.QueryRow(ctx, `SELECT host_id, identity_public_key, e2ee_public_key, credential_version
        FROM relay_hosts WHERE host_id = $1 AND status = 'active'`, hostID).Scan(
		&host.HostID, &host.IdentityPublicKey, &host.E2EEPublicKey, &host.CredentialVersion,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Host{}, ErrNotFound
	}
	return host, err
}

func (s *Postgres) CreateInvite(ctx context.Context, hostID, deviceID string, ttl time.Duration) (Invite, error) {
	inviteID, err := randomCredential("invite_", 18)
	if err != nil {
		return Invite{}, err
	}
	token, err := randomCredential("invitecred_", 32)
	if err != nil {
		return Invite{}, err
	}
	expiresAt := time.Now().Add(ttl)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Invite{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE relay_invites SET revoked_at = NOW()
        WHERE host_id = $1 AND device_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL`, hostID, deviceID); err != nil {
		return Invite{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO relay_invites
        (invite_id, host_id, device_id, invite_token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
		inviteID, hostID, deviceID, tokenHash(token), expiresAt); err != nil {
		return Invite{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Invite{}, err
	}
	return Invite{InviteID: inviteID, InviteToken: token, DeviceID: deviceID, ExpiresAt: expiresAt}, nil
}

func (s *Postgres) RevokeInvite(ctx context.Context, hostID, inviteID string) error {
	command, err := s.pool.Exec(ctx, `UPDATE relay_invites SET revoked_at = NOW()
        WHERE invite_id = $1 AND host_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL`, inviteID, hostID)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *Postgres) ConsumeInvite(ctx context.Context, hostID, token string) (DeviceCredential, error) {
	hash := tokenHash(token)
	var credential DeviceCredential
	err := s.pool.QueryRow(ctx, `UPDATE relay_invites SET consumed_at = NOW()
        WHERE host_id = $1 AND invite_token_hash = $2 AND expires_at > NOW()
          AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING host_id, device_id`, hostID, hash).Scan(&credential.HostID, &credential.DeviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return DeviceCredential{}, ErrInviteUnavailable
	}
	if err != nil {
		return DeviceCredential{}, err
	}
	credential.Kind = "invite"
	credential.Version = 1
	return credential, nil
}

func (s *Postgres) InstallDevice(ctx context.Context, hostID, deviceID, resumeToken string, version int, expiresAt time.Time) error {
	return s.InstallDeviceHash(ctx, hostID, deviceID, tokenHash(resumeToken), version, expiresAt)
}

func (s *Postgres) InstallDeviceHash(ctx context.Context, hostID, deviceID string, resumeTokenHash []byte, version int, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO relay_devices
        (host_id, device_id, resume_token_hash, credential_version, expires_at)
        VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (host_id, device_id) DO UPDATE SET
		  resume_token_hash = EXCLUDED.resume_token_hash,
		  credential_version = EXCLUDED.credential_version,
		  expires_at = EXCLUDED.expires_at,
		  grace_token_hash = relay_devices.resume_token_hash,
		  grace_expires_at = NOW() + INTERVAL '5 minutes',
		  revoked_at = NULL`, hostID, deviceID, resumeTokenHash, version, expiresAt)
	return err
}

func (s *Postgres) AuthenticateResume(ctx context.Context, hostID, deviceID, presentedToken string) (DeviceCredential, error) {
	var currentHash, graceHash []byte
	var version int
	var expiresAt time.Time
	var graceExpiresAt *time.Time
	var revokedAt *time.Time
	err := s.pool.QueryRow(ctx, `SELECT resume_token_hash, grace_token_hash, credential_version, expires_at, grace_expires_at, revoked_at
        FROM relay_devices WHERE host_id = $1 AND device_id = $2`, hostID, deviceID).Scan(
		&currentHash, &graceHash, &version, &expiresAt, &graceExpiresAt, &revokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return DeviceCredential{}, ErrCredential
	}
	if err != nil {
		return DeviceCredential{}, err
	}
	now := time.Now()
	presentedHash := tokenHash(presentedToken)
	currentMatches := len(currentHash) == sha256.Size && subtle.ConstantTimeCompare(currentHash, presentedHash) == 1 && expiresAt.After(now)
	graceMatches := len(graceHash) == sha256.Size && subtle.ConstantTimeCompare(graceHash, presentedHash) == 1 && graceExpiresAt != nil && graceExpiresAt.After(now)
	if revokedAt != nil || (!currentMatches && !graceMatches) {
		return DeviceCredential{}, ErrCredential
	}
	return DeviceCredential{HostID: hostID, DeviceID: deviceID, Kind: "resume", Version: version}, nil
}

func (s *Postgres) RotateResume(ctx context.Context, hostID, deviceID, presentedToken string, ttl, graceTTL time.Duration) (string, int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var currentHash, graceHash []byte
	var version int
	var expiresAt time.Time
	var graceExpiresAt *time.Time
	var revokedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT resume_token_hash, grace_token_hash, credential_version, expires_at, grace_expires_at, revoked_at
        FROM relay_devices WHERE host_id = $1 AND device_id = $2 FOR UPDATE`, hostID, deviceID).Scan(
		&currentHash, &graceHash, &version, &expiresAt, &graceExpiresAt, &revokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, ErrCredential
	}
	if err != nil {
		return "", 0, err
	}
	now := time.Now()
	presentedHash := tokenHash(presentedToken)
	currentMatches := subtle.ConstantTimeCompare(currentHash, presentedHash) == 1 && expiresAt.After(now)
	graceMatches := len(graceHash) == sha256.Size && subtle.ConstantTimeCompare(graceHash, presentedHash) == 1 && graceExpiresAt != nil && graceExpiresAt.After(now)
	if revokedAt != nil || (!currentMatches && !graceMatches) {
		return "", 0, ErrCredential
	}
	newToken, err := randomCredential("resume_", 32)
	if err != nil {
		return "", 0, err
	}
	version++
	_, err = tx.Exec(ctx, `UPDATE relay_devices SET
        resume_token_hash = $3, credential_version = $4, expires_at = $5,
        grace_token_hash = resume_token_hash, grace_expires_at = $6
        WHERE host_id = $1 AND device_id = $2`, hostID, deviceID, tokenHash(newToken), version, now.Add(ttl), now.Add(graceTTL))
	if err != nil {
		return "", 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", 0, err
	}
	return newToken, version, nil
}

func (s *Postgres) RevokeDevice(ctx context.Context, hostID, deviceID string) error {
	command, err := s.pool.Exec(ctx, `UPDATE relay_devices SET revoked_at = NOW()
        WHERE host_id = $1 AND device_id = $2 AND revoked_at IS NULL`, hostID, deviceID)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *Postgres) RecordAudit(ctx context.Context, eventType, resultCode, hostID, deviceID string, metadata map[string]any) error {
	if metadata == nil {
		metadata = map[string]any{}
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO relay_audit_events
        (host_id, device_id, event_type, result_code, metadata_json)
        VALUES (NULLIF($1, ''), NULLIF($2, ''), $3, $4, $5)`, hostID, deviceID, eventType, resultCode, encoded)
	return err
}

func tokenHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func randomCredential(prefix string, bytesCount int) (string, error) {
	data := make([]byte, bytesCount)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(data), nil
}
