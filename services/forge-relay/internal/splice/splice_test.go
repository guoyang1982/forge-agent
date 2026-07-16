package splice

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/metrics"
)

type frame struct {
	typeID  MessageType
	payload []byte
	err     error
}

type fakeEndpoint struct {
	reads    chan frame
	writes   chan frame
	closed   chan error
	block    bool
	closeOne sync.Once
}

func newFakeEndpoint() *fakeEndpoint {
	return &fakeEndpoint{reads: make(chan frame, 4), writes: make(chan frame, 4), closed: make(chan error, 1)}
}

func (f *fakeEndpoint) Read(ctx context.Context) (MessageType, []byte, error) {
	select {
	case value := <-f.reads:
		return value.typeID, value.payload, value.err
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	}
}

func (f *fakeEndpoint) Write(ctx context.Context, messageType MessageType, payload []byte) error {
	if f.block {
		<-ctx.Done()
		return ctx.Err()
	}
	select {
	case f.writes <- frame{typeID: messageType, payload: append([]byte(nil), payload...)}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (f *fakeEndpoint) Close(err error) { f.closeOne.Do(func() { f.closed <- err }) }

func TestSplicerForwardsOpaquePayload(t *testing.T) {
	phone, host := newFakeEndpoint(), newFakeEndpoint()
	splicer := New(Config{MaxFrameBytes: 1024, WriteTimeout: time.Second}, &metrics.Metrics{})
	payload := []byte("opaque-secretbox-ciphertext")
	phone.reads <- frame{typeID: MessageBinary, payload: payload}
	phone.reads <- frame{err: errors.New("done")}

	done := make(chan error, 1)
	go func() { done <- splicer.Run(context.Background(), phone, host) }()
	select {
	case forwarded := <-host.writes:
		if string(forwarded.payload) != string(payload) || forwarded.typeID != MessageBinary {
			t.Fatalf("forwarded frame = %#v", forwarded)
		}
	case <-time.After(time.Second):
		t.Fatal("payload was not forwarded")
	}
	<-done
}

func TestSplicerRejectsOversizedFrame(t *testing.T) {
	phone, host := newFakeEndpoint(), newFakeEndpoint()
	splicer := New(Config{MaxFrameBytes: 1024 * 1024, WriteTimeout: time.Second}, &metrics.Metrics{})
	phone.reads <- frame{typeID: MessageBinary, payload: make([]byte, 1024*1024+1)}
	if err := splicer.Run(context.Background(), phone, host); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("Run() error = %v", err)
	}
}

func TestSplicerDisconnectsSlowConsumer(t *testing.T) {
	phone, host := newFakeEndpoint(), newFakeEndpoint()
	host.block = true
	splicer := New(Config{MaxFrameBytes: 1024, WriteTimeout: 10 * time.Millisecond}, &metrics.Metrics{})
	phone.reads <- frame{typeID: MessageBinary, payload: []byte("frame")}
	if err := splicer.Run(context.Background(), phone, host); !errors.Is(err, ErrBackpressure) {
		t.Fatalf("Run() error = %v", err)
	}
}
