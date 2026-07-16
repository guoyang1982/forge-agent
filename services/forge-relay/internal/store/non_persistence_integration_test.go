package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"golang.org/x/crypto/nacl/secretbox"

	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/audit"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/control"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/lease"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/metrics"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/splice"
)

type persistenceFrame struct {
	payload []byte
	err     error
}

type persistenceEndpoint struct {
	reads  chan persistenceFrame
	writes chan []byte
	done   chan struct{}
}

func newPersistenceEndpoint() *persistenceEndpoint {
	return &persistenceEndpoint{reads: make(chan persistenceFrame, 2), writes: make(chan []byte, 2), done: make(chan struct{}, 2)}
}

func (e *persistenceEndpoint) Read(ctx context.Context) (splice.MessageType, []byte, error) {
	select {
	case frame := <-e.reads:
		return splice.MessageBinary, frame.payload, frame.err
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	}
}

func (e *persistenceEndpoint) Write(ctx context.Context, _ splice.MessageType, payload []byte) error {
	select {
	case e.writes <- append([]byte(nil), payload...):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (e *persistenceEndpoint) Close(error) {
	select {
	case e.done <- struct{}{}:
	default:
	}
}

func TestInnerPlaintextIsNotLoggedOrPersisted(t *testing.T) {
	database := testDatabase(t)
	ctx := context.Background()
	host, _, err := database.EnrollHost(ctx, make([]byte, 32), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	invite, err := database.CreateInvite(ctx, host.HostID, "device_opaque01", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	credential, err := database.ConsumeInvite(ctx, host.HostID, invite.InviteToken)
	if err != nil {
		t.Fatal(err)
	}

	const plaintextMarker = "FORGE_INNER_PLAINTEXT_MUST_NEVER_REACH_RELAY_7A91D2"
	var key [32]byte
	var nonce [24]byte
	copy(key[:], []byte("relay-test-key-only-not-production"))
	copy(nonce[:], []byte("unique-relay-test-nonce"))
	ciphertext := secretbox.Seal(nil, []byte(plaintextMarker), &nonce, &key)
	if bytes.Contains(ciphertext, []byte(plaintextMarker)) {
		t.Fatal("test ciphertext unexpectedly contains plaintext")
	}

	controlMessages := make(chan []byte, 1)
	hosts := lease.NewRegistry(1)
	_, err = hosts.Register(lease.Host{
		HostID: host.HostID, LeaseID: "lease_opaque01", ExpiresAt: time.Now().Add(time.Minute),
		Send: func(data []byte) error { controlMessages <- append([]byte(nil), data...); return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	phone, hostData := newPersistenceEndpoint(), newPersistenceEndpoint()
	phone.reads <- persistenceFrame{payload: ciphertext}
	phone.reads <- persistenceFrame{err: io.EOF}
	broker := control.NewBroker(hosts, splice.New(splice.Config{MaxFrameBytes: 1024 * 1024, WriteTimeout: time.Second}, &metrics.Metrics{}), time.Second)
	connID, err := broker.Open(host.HostID, credential.DeviceID, credential.Kind, phone)
	if err != nil {
		t.Fatal(err)
	}
	var opened struct {
		ConnTicket string `json:"connTicket"`
	}
	if err := json.Unmarshal(<-controlMessages, &opened); err != nil {
		t.Fatal(err)
	}
	if err := broker.Attach(ctx, connID, opened.ConnTicket, hostData); err != nil {
		t.Fatal(err)
	}
	select {
	case forwarded := <-hostData.writes:
		if !bytes.Equal(forwarded, ciphertext) {
			t.Fatal("Relay changed opaque ciphertext")
		}
	case <-time.After(time.Second):
		t.Fatal("ciphertext was not forwarded")
	}

	var logs bytes.Buffer
	auditor := audit.New(slog.New(slog.NewJSONHandler(&logs, nil)))
	auditor.Event("connection.closed", "ok", host.HostID, credential.DeviceID, "bytes", len(ciphertext))
	if err := database.RecordAudit(ctx, "connection.closed", "ok", host.HostID, credential.DeviceID, map[string]any{"bytes": len(ciphertext)}); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(logs.Bytes(), []byte(plaintextMarker)) {
		t.Fatal("inner plaintext appeared in structured logs")
	}

	pattern := "%" + plaintextMarker + "%"
	var found bool
	err = database.pool.QueryRow(ctx, `SELECT EXISTS (
        SELECT 1 FROM relay_hosts
          WHERE host_id LIKE $1 OR encode(identity_public_key, 'escape') LIKE $1
             OR encode(e2ee_public_key, 'escape') LIKE $1 OR encode(credential_hash, 'escape') LIKE $1
        UNION ALL
        SELECT 1 FROM relay_devices
          WHERE host_id LIKE $1 OR device_id LIKE $1 OR encode(resume_token_hash, 'escape') LIKE $1
             OR encode(grace_token_hash, 'escape') LIKE $1
        UNION ALL
        SELECT 1 FROM relay_invites
          WHERE invite_id LIKE $1 OR host_id LIKE $1 OR device_id LIKE $1 OR encode(invite_token_hash, 'escape') LIKE $1
        UNION ALL
        SELECT 1 FROM relay_audit_events
          WHERE COALESCE(host_id, '') LIKE $1 OR COALESCE(device_id, '') LIKE $1
             OR event_type LIKE $1 OR result_code LIKE $1 OR metadata_json::text LIKE $1
    )`, pattern).Scan(&found)
	if err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if found {
		t.Fatal("inner plaintext appeared in Relay PostgreSQL state")
	}
}
