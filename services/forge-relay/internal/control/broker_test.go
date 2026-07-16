package control

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/lease"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/metrics"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/splice"
)

type inertEndpoint struct{ closed chan error }

func newInertEndpoint() *inertEndpoint { return &inertEndpoint{closed: make(chan error, 2)} }
func (e *inertEndpoint) Read(ctx context.Context) (splice.MessageType, []byte, error) {
	<-ctx.Done()
	return 0, nil, ctx.Err()
}
func (e *inertEndpoint) Write(context.Context, splice.MessageType, []byte) error { return nil }
func (e *inertEndpoint) Close(err error)                                         { e.closed <- err }

func TestTicketCanOnlyBeAttachedOnce(t *testing.T) {
	hosts := lease.NewRegistry(1)
	controlMessages := make(chan []byte, 1)
	_, err := hosts.Register(lease.Host{
		HostID: "host_00000001", LeaseID: "lease_000001", ExpiresAt: time.Now().Add(time.Minute),
		Send: func(data []byte) error { controlMessages <- data; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	broker := NewBroker(hosts, splice.New(splice.Config{MaxFrameBytes: 1024, WriteTimeout: time.Second}, &metrics.Metrics{}), time.Second)
	phone := newInertEndpoint()
	connID, err := broker.Open("host_00000001", "device_000001", "invite", phone)
	if err != nil {
		t.Fatal(err)
	}
	var opened struct {
		ConnTicket string `json:"connTicket"`
	}
	if err := json.Unmarshal(<-controlMessages, &opened); err != nil {
		t.Fatal(err)
	}
	if err := broker.Attach(context.Background(), connID, opened.ConnTicket, newInertEndpoint()); err != nil {
		t.Fatalf("first Attach() error = %v", err)
	}
	if err := broker.Attach(context.Background(), connID, opened.ConnTicket, newInertEndpoint()); !errors.Is(err, ErrConnectionNotFound) {
		t.Fatalf("second Attach() error = %v", err)
	}
}

func TestWrongTicketDoesNotConsumeCorrectTicket(t *testing.T) {
	hosts := lease.NewRegistry(1)
	controlMessages := make(chan []byte, 1)
	_, _ = hosts.Register(lease.Host{
		HostID: "host_00000001", LeaseID: "lease_000001", ExpiresAt: time.Now().Add(time.Minute),
		Send: func(data []byte) error { controlMessages <- data; return nil },
	})
	broker := NewBroker(hosts, splice.New(splice.Config{MaxFrameBytes: 1024, WriteTimeout: time.Second}, &metrics.Metrics{}), time.Second)
	connID, err := broker.Open("host_00000001", "device_000001", "resume", newInertEndpoint())
	if err != nil {
		t.Fatal(err)
	}
	var opened struct {
		ConnTicket string `json:"connTicket"`
	}
	_ = json.Unmarshal(<-controlMessages, &opened)
	if err := broker.Attach(context.Background(), connID, "ticket_wrong_wrong_wrong_wrong_wrong", newInertEndpoint()); !errors.Is(err, ErrTicketInvalid) {
		t.Fatalf("wrong ticket error = %v", err)
	}
	if err := broker.Attach(context.Background(), connID, opened.ConnTicket, newInertEndpoint()); err != nil {
		t.Fatalf("correct ticket error = %v", err)
	}
}

func TestDeviceRevocationIsScopedToHost(t *testing.T) {
	hosts := lease.NewRegistry(2)
	for _, hostID := range []string{"host_00000001", "host_00000002"} {
		_, err := hosts.Register(lease.Host{
			HostID: hostID, LeaseID: "lease_" + hostID, ExpiresAt: time.Now().Add(time.Minute),
			Send: func([]byte) error { return nil },
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	broker := NewBroker(hosts, splice.New(splice.Config{MaxFrameBytes: 1024, WriteTimeout: time.Second}, &metrics.Metrics{}), time.Minute)
	phoneOne, phoneTwo := newInertEndpoint(), newInertEndpoint()
	if _, err := broker.Open("host_00000001", "device_shared1", "resume", phoneOne); err != nil {
		t.Fatal(err)
	}
	if _, err := broker.Open("host_00000002", "device_shared1", "resume", phoneTwo); err != nil {
		t.Fatal(err)
	}
	broker.CloseDevice("host_00000001", "device_shared1", errors.New("revoked"))
	select {
	case <-phoneOne.closed:
	case <-time.After(time.Second):
		t.Fatal("revoked host connection was not closed")
	}
	select {
	case <-phoneTwo.closed:
		t.Fatal("same device ID on another host was closed")
	default:
	}
}

func TestDeviceRevocationClosesActiveSplice(t *testing.T) {
	hosts := lease.NewRegistry(1)
	controlMessages := make(chan []byte, 1)
	_, _ = hosts.Register(lease.Host{
		HostID: "host_00000001", LeaseID: "lease_000001", ExpiresAt: time.Now().Add(time.Minute),
		Send: func(data []byte) error { controlMessages <- data; return nil },
	})
	broker := NewBroker(hosts, splice.New(splice.Config{MaxFrameBytes: 1024, WriteTimeout: time.Second}, &metrics.Metrics{}), time.Minute)
	phone, hostEndpoint := newInertEndpoint(), newInertEndpoint()
	connID, err := broker.Open("host_00000001", "device_000001", "resume", phone)
	if err != nil {
		t.Fatal(err)
	}
	var opened struct {
		ConnTicket string `json:"connTicket"`
	}
	_ = json.Unmarshal(<-controlMessages, &opened)
	if err := broker.Attach(context.Background(), connID, opened.ConnTicket, hostEndpoint); err != nil {
		t.Fatal(err)
	}
	broker.CloseDevice("host_00000001", "device_000001", errors.New("revoked"))
	for name, endpoint := range map[string]*inertEndpoint{"phone": phone, "host": hostEndpoint} {
		select {
		case <-endpoint.closed:
		case <-time.After(time.Second):
			t.Fatalf("%s endpoint was not closed", name)
		}
	}
}
