package httpapi

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/auth"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/config"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/control"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/lease"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/splice"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/store"
)

func TestUnauthorizedPhoneCannotTriggerConnectionOpen(t *testing.T) {
	databaseURL := os.Getenv("FORGE_RELAY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FORGE_RELAY_TEST_DATABASE_URL is not configured")
	}
	database, err := store.Open(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.Migrator().Up(context.Background()); err != nil {
		t.Fatal(err)
	}

	hosts := lease.NewRegistry(1)
	var opens atomic.Int64
	_, err = hosts.Register(lease.Host{
		HostID: "host_00000001", LeaseID: "lease_000001", ExpiresAt: time.Now().Add(time.Minute),
		Send: func([]byte) error { opens.Add(1); return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	_, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := auth.NewSigner("http://127.0.0.1", privateKey)
	cfg := config.Config{PublicOrigin: "http://127.0.0.1", MaxFrameBytes: 1024 * 1024, AttachTimeout: time.Second, HostLeaseDuration: time.Minute}
	api := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), hosts)
	broker := control.NewBroker(hosts, splice.New(splice.Config{MaxFrameBytes: cfg.MaxFrameBytes, WriteTimeout: time.Second}, api.Metrics()), time.Second)
	api.EnableRelayRoutes(RelayDependencies{Store: database, Signer: signer, Broker: broker})
	testServer := httptest.NewServer(api.Handler())
	defer testServer.Close()

	headers := http.Header{}
	headers.Set("Authorization", "Bearer invalid-invite-token")
	headers.Set("X-Forge-Credential-Kind", "invite")
	_, response, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(testServer.URL, "http")+"/v1/connect/host_00000001", &websocket.DialOptions{HTTPHeader: headers})
	if err == nil {
		t.Fatal("unauthorized phone unexpectedly connected")
	}
	if response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("upgrade response = %#v, error = %v", response, err)
	}
	if opens.Load() != 0 {
		t.Fatalf("unauthorized request triggered %d connection.open messages", opens.Load())
	}
}
