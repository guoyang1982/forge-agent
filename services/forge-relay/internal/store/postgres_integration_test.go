package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func testDatabase(t *testing.T) *Postgres {
	t.Helper()
	databaseURL := os.Getenv("FORGE_RELAY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FORGE_RELAY_TEST_DATABASE_URL is not configured")
	}
	database, err := Open(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	if err := database.Migrator().Up(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := database.pool.Exec(context.Background(), "TRUNCATE relay_audit_events, relay_invites, relay_devices, relay_hosts RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	return database
}

func TestMigrationsAreIdempotent(t *testing.T) {
	database := testDatabase(t)
	if err := database.Migrator().Up(context.Background()); err != nil {
		t.Fatalf("second migration run failed: %v", err)
	}
}

func TestInviteCanOnlyBeConsumedOnce(t *testing.T) {
	database := testDatabase(t)
	host, _, err := database.EnrollHost(context.Background(), make([]byte, 32), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	invite, err := database.CreateInvite(context.Background(), host.HostID, "device_000001", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ConsumeInvite(context.Background(), host.HostID, invite.InviteToken); err != nil {
		t.Fatalf("first consume failed: %v", err)
	}
	if _, err := database.ConsumeInvite(context.Background(), host.HostID, invite.InviteToken); !errors.Is(err, ErrInviteUnavailable) {
		t.Fatalf("second consume error = %v", err)
	}
}

func TestResumeCurrentAndGraceSurviveStoreRestart(t *testing.T) {
	database := testDatabase(t)
	databaseURL := os.Getenv("FORGE_RELAY_TEST_DATABASE_URL")
	host, _, err := database.EnrollHost(context.Background(), make([]byte, 32), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.InstallDevice(context.Background(), host.HostID, "device_000001", "resume_token_old", 1, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := database.InstallDevice(context.Background(), host.HostID, "device_000001", "resume_token_current", 2, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	database.Close()

	restarted, err := Open(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	for _, token := range []string{"resume_token_current", "resume_token_old"} {
		credential, err := restarted.AuthenticateResume(context.Background(), host.HostID, "device_000001", token)
		if err != nil || credential.Kind != "resume" || credential.Version != 2 {
			t.Fatalf("AuthenticateResume(%q) = %#v, %v", token, credential, err)
		}
	}
	if err := restarted.RevokeDevice(context.Background(), host.HostID, "device_000001"); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.AuthenticateResume(context.Background(), host.HostID, "device_000001", "resume_token_current"); !errors.Is(err, ErrCredential) {
		t.Fatalf("revoked device error = %v", err)
	}
}
