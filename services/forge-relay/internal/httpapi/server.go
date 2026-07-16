package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/audit"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/buildinfo"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/config"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/lease"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/metrics"
)

type Server struct {
	cfg        config.Config
	log        *slog.Logger
	hosts      *lease.Registry
	ready      atomic.Bool
	handler    http.Handler
	mux        *http.ServeMux
	metrics    *metrics.Metrics
	readyCheck func(context.Context) error
	auditor    *audit.Logger
}

func New(cfg config.Config, log *slog.Logger, hosts *lease.Registry) *Server {
	s := &Server{cfg: cfg, log: log, hosts: hosts, metrics: &metrics.Metrics{}, auditor: audit.New(log)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.readiness)
	mux.HandleFunc("GET /metrics", s.prometheus)
	s.mux = mux
	s.handler = securityHeaders(mux)
	s.ready.Store(true)
	return s
}

func (s *Server) prometheus(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	s.metrics.SetHostsOnline(s.hosts.Online())
	s.metrics.WritePrometheus(w)
}

func (s *Server) Handler() http.Handler { return s.handler }

func (s *Server) Metrics() *metrics.Metrics { return s.metrics }

func (s *Server) SetReady(ready bool) { s.ready.Store(ready) }

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "version": buildinfo.Version})
}

func (s *Server) readiness(w http.ResponseWriter, r *http.Request) {
	if !s.ready.Load() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "not_ready"})
		return
	}
	if s.readyCheck != nil {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if err := s.readyCheck(ctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "not_ready"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "version": buildinfo.Version, "hostsOnline": s.hosts.Online()})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
