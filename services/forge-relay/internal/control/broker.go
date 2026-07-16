package control

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/lease"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/splice"
)

var (
	ErrConnectionNotFound = errors.New("connection not found")
	ErrTicketInvalid      = errors.New("connection ticket is invalid or already consumed")
	ErrAttachTimeout      = errors.New("host data attach timed out")
)

type pendingConnection struct {
	hostID     string
	deviceID   string
	ticketHash [32]byte
	phone      splice.Endpoint
	expiresAt  time.Time
}

type activeConnection struct {
	hostID   string
	deviceID string
	phone    splice.Endpoint
	host     splice.Endpoint
}

type Broker struct {
	mu            sync.Mutex
	hosts         *lease.Registry
	splicer       *splice.Splicer
	attachTimeout time.Duration
	pending       map[string]pendingConnection
	active        map[string]activeConnection
	now           func() time.Time
}

func NewBroker(hosts *lease.Registry, splicer *splice.Splicer, attachTimeout time.Duration) *Broker {
	return &Broker{
		hosts:         hosts,
		splicer:       splicer,
		attachTimeout: attachTimeout,
		pending:       make(map[string]pendingConnection),
		active:        make(map[string]activeConnection),
		now:           time.Now,
	}
}

func (b *Broker) Open(hostID, deviceID, credentialKind string, phone splice.Endpoint) (string, error) {
	host, err := b.hosts.Get(hostID)
	if err != nil {
		return "", err
	}
	connID, err := randomID("connection_", 18)
	if err != nil {
		return "", err
	}
	ticket, err := randomID("ticket_", 32)
	if err != nil {
		return "", err
	}
	expiresAt := b.now().Add(b.attachTimeout)
	pending := pendingConnection{
		hostID: hostID, deviceID: deviceID, ticketHash: sha256.Sum256([]byte(ticket)), phone: phone, expiresAt: expiresAt,
	}
	b.mu.Lock()
	b.pending[connID] = pending
	b.mu.Unlock()

	message, _ := json.Marshal(map[string]any{
		"v": 1, "type": "connection.open", "connId": connID, "connTicket": ticket,
		"deviceId": deviceID, "credentialKind": credentialKind, "attachDeadline": expiresAt.UnixMilli(),
	})
	if err := host.Send(message); err != nil {
		b.removePending(connID, err)
		return "", err
	}
	time.AfterFunc(b.attachTimeout, func() { b.expire(connID) })
	return connID, nil
}

func (b *Broker) Attach(ctx context.Context, connID, ticket string, hostEndpoint splice.Endpoint) error {
	b.mu.Lock()
	pending, ok := b.pending[connID]
	if !ok {
		b.mu.Unlock()
		return ErrConnectionNotFound
	}
	ticketHash := sha256.Sum256([]byte(ticket))
	if subtle.ConstantTimeCompare(ticketHash[:], pending.ticketHash[:]) != 1 || !pending.expiresAt.After(b.now()) {
		b.mu.Unlock()
		return ErrTicketInvalid
	}
	delete(b.pending, connID)
	b.active[connID] = activeConnection{hostID: pending.hostID, deviceID: pending.deviceID, phone: pending.phone, host: hostEndpoint}
	b.mu.Unlock()

	go func() {
		_ = b.splicer.Run(ctx, pending.phone, hostEndpoint)
		b.mu.Lock()
		delete(b.active, connID)
		b.mu.Unlock()
	}()
	return nil
}

func (b *Broker) CloseDevice(hostID, deviceID string, reason error) {
	b.mu.Lock()
	var endpoints []splice.Endpoint
	for connID, pending := range b.pending {
		if pending.hostID == hostID && pending.deviceID == deviceID {
			delete(b.pending, connID)
			endpoints = append(endpoints, pending.phone)
		}
	}
	for connID, active := range b.active {
		if active.hostID == hostID && active.deviceID == deviceID {
			delete(b.active, connID)
			endpoints = append(endpoints, active.phone, active.host)
		}
	}
	b.mu.Unlock()
	for _, endpoint := range endpoints {
		endpoint.Close(reason)
	}
}

func (b *Broker) expire(connID string) {
	b.mu.Lock()
	pending, ok := b.pending[connID]
	if ok && !pending.expiresAt.After(b.now()) {
		delete(b.pending, connID)
	}
	b.mu.Unlock()
	if ok {
		pending.phone.Close(ErrAttachTimeout)
	}
}

func (b *Broker) removePending(connID string, reason error) {
	b.mu.Lock()
	pending, ok := b.pending[connID]
	delete(b.pending, connID)
	b.mu.Unlock()
	if ok {
		pending.phone.Close(reason)
	}
}

func randomID(prefix string, bytesCount int) (string, error) {
	data := make([]byte, bytesCount)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(data), nil
}
