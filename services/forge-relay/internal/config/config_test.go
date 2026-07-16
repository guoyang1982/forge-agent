package config

import "testing"

func TestConfigRejectsPublicHTTPOrigin(t *testing.T) {
	t.Setenv("FORGE_RELAY_PUBLIC_ORIGIN", "http://relay.example.com")
	if _, err := Load(); err == nil {
		t.Fatal("expected public HTTP origin to be rejected")
	}
}

func TestConfigAcceptsLocalhostHTTPOrigin(t *testing.T) {
	t.Setenv("FORGE_RELAY_PUBLIC_ORIGIN", "http://127.0.0.1:8080")
	if _, err := Load(); err != nil {
		t.Fatalf("Load() error = %v", err)
	}
}
