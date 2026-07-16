package splice

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/metrics"
)

var (
	ErrFrameTooLarge = errors.New("frame exceeds relay limit")
	ErrBackpressure  = errors.New("slow consumer backpressure limit reached")
)

type MessageType int

const (
	MessageText   MessageType = 1
	MessageBinary MessageType = 2
)

type Endpoint interface {
	Read(context.Context) (MessageType, []byte, error)
	Write(context.Context, MessageType, []byte) error
	Close(error)
}

type Config struct {
	MaxFrameBytes int64
	WriteTimeout  time.Duration
}

type Splicer struct {
	cfg     Config
	metrics *metrics.Metrics
}

func New(cfg Config, metrics *metrics.Metrics) *Splicer {
	return &Splicer{cfg: cfg, metrics: metrics}
}

func (s *Splicer) Run(ctx context.Context, phone, host Endpoint) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.metrics.AddSplices(1)
	defer s.metrics.AddSplices(-1)

	errorsChannel := make(chan error, 2)
	go s.copy(ctx, errorsChannel, phone, host, true)
	go s.copy(ctx, errorsChannel, host, phone, false)
	err := <-errorsChannel
	cancel()
	phone.Close(err)
	host.Close(err)
	<-errorsChannel
	return err
}

func (s *Splicer) copy(ctx context.Context, result chan<- error, source, destination Endpoint, phoneToHost bool) {
	for {
		messageType, payload, err := source.Read(ctx)
		if err != nil {
			result <- err
			return
		}
		if int64(len(payload)) > s.cfg.MaxFrameBytes {
			result <- ErrFrameTooLarge
			return
		}
		writeCtx, cancel := context.WithTimeout(ctx, s.cfg.WriteTimeout)
		err = destination.Write(writeCtx, messageType, payload)
		cancel()
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				s.metrics.RecordBackpressureDisconnect()
				result <- ErrBackpressure
				return
			}
			result <- err
			return
		}
		s.metrics.RecordFrame(phoneToHost, len(payload))
	}
}

type WebSocketEndpoint struct {
	conn      *websocket.Conn
	closeOnce sync.Once
	done      chan struct{}
}

func NewWebSocketEndpoint(conn *websocket.Conn, maxFrameBytes int64) *WebSocketEndpoint {
	conn.SetReadLimit(maxFrameBytes + 1)
	return &WebSocketEndpoint{conn: conn, done: make(chan struct{})}
}

func (e *WebSocketEndpoint) Done() <-chan struct{} { return e.done }

func (e *WebSocketEndpoint) Read(ctx context.Context) (MessageType, []byte, error) {
	messageType, payload, err := e.conn.Read(ctx)
	if err != nil {
		return 0, nil, err
	}
	switch messageType {
	case websocket.MessageText:
		return MessageText, payload, nil
	case websocket.MessageBinary:
		return MessageBinary, payload, nil
	default:
		return 0, nil, fmt.Errorf("unsupported WebSocket message type %d", messageType)
	}
}

func (e *WebSocketEndpoint) Write(ctx context.Context, messageType MessageType, payload []byte) error {
	wsType := websocket.MessageBinary
	if messageType == MessageText {
		wsType = websocket.MessageText
	}
	return e.conn.Write(ctx, wsType, payload)
}

func (e *WebSocketEndpoint) Close(reason error) {
	e.closeOnce.Do(func() {
		defer close(e.done)
		status := websocket.StatusNormalClosure
		message := "connection closed"
		if reason != nil {
			status = websocket.StatusPolicyViolation
			message = "relay policy closed connection"
		}
		_ = e.conn.Close(status, message)
	})
}
