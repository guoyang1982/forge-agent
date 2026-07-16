package lease

import (
	"errors"
	"testing"
	"time"
)

func TestRegisterReplacesExistingConnection(t *testing.T) {
	r := NewRegistry(1)
	now := time.Unix(1_700_000_000, 0)
	r.now = func() time.Time { return now }
	replaced := make(chan error, 1)
	_, err := r.Register(Host{HostID: "host_12345678", LeaseID: "lease_old123", ExpiresAt: now.Add(time.Minute), Close: func(err error) { replaced <- err }})
	if err != nil {
		t.Fatal(err)
	}
	wasReplaced, err := r.Register(Host{HostID: "host_12345678", LeaseID: "lease_new123", ExpiresAt: now.Add(time.Minute)})
	if err != nil || !wasReplaced {
		t.Fatalf("Register() = %v, %v", wasReplaced, err)
	}
	select {
	case err := <-replaced:
		if err == nil {
			t.Fatal("expected replacement reason")
		}
	case <-time.After(time.Second):
		t.Fatal("old connection was not closed")
	}
}

func TestExpiredHostIsOffline(t *testing.T) {
	r := NewRegistry(1)
	now := time.Unix(1_700_000_000, 0)
	r.now = func() time.Time { return now }
	_, _ = r.Register(Host{HostID: "host_12345678", LeaseID: "lease_12345678", ExpiresAt: now.Add(-time.Second)})
	if _, err := r.Get("host_12345678"); !errors.Is(err, ErrHostOffline) {
		t.Fatalf("Get() error = %v", err)
	}
}
