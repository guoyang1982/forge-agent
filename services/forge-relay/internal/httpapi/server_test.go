package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/config"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/lease"
)

func TestHealthAndReadiness(t *testing.T) {
	server := New(config.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), lease.NewRegistry(10))

	for _, path := range []string{"/healthz", "/readyz"} {
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d", path, response.Code)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("GET %s missing no-store", path)
		}
	}

	server.SetReady(false)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /readyz status = %d", response.Code)
	}
}
