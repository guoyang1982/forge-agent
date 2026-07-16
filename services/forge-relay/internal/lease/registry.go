package lease

import (
	"errors"
	"sync"
	"time"
)

var (
	ErrHostOffline  = errors.New("host is offline")
	ErrHostLimit    = errors.New("host limit reached")
	ErrLeaseInvalid = errors.New("lease is invalid")
)

type Host struct {
	HostID    string
	LeaseID   string
	ExpiresAt time.Time
	Send      func([]byte) error
	Close     func(error)
}

type Registry struct {
	mu       sync.RWMutex
	hosts    map[string]Host
	maxHosts int
	now      func() time.Time
}

func NewRegistry(maxHosts int) *Registry {
	return &Registry{hosts: make(map[string]Host), maxHosts: maxHosts, now: time.Now}
}

func (r *Registry) Register(host Host) (replaced bool, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	previous, exists := r.hosts[host.HostID]
	if !exists && len(r.hosts) >= r.maxHosts {
		return false, ErrHostLimit
	}
	r.hosts[host.HostID] = host
	if exists && previous.Close != nil {
		go previous.Close(errors.New("host control connection replaced"))
	}
	return exists, nil
}

func (r *Registry) Get(hostID string) (Host, error) {
	r.mu.RLock()
	host, ok := r.hosts[hostID]
	r.mu.RUnlock()
	if !ok || !host.ExpiresAt.After(r.now()) {
		return Host{}, ErrHostOffline
	}
	return host, nil
}

func (r *Registry) Renew(hostID, leaseID string, expiresAt time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	host, ok := r.hosts[hostID]
	if !ok || host.LeaseID != leaseID || !host.ExpiresAt.After(r.now()) {
		return ErrLeaseInvalid
	}
	host.ExpiresAt = expiresAt
	r.hosts[hostID] = host
	return nil
}

func (r *Registry) Unregister(hostID, leaseID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if host, ok := r.hosts[hostID]; ok && host.LeaseID == leaseID {
		delete(r.hosts, hostID)
	}
}

func (r *Registry) Online() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	now := r.now()
	count := 0
	for _, host := range r.hosts {
		if host.ExpiresAt.After(now) {
			count++
		}
	}
	return count
}
