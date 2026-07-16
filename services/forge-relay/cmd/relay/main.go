package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"syscall"
	"time"

	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/auth"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/config"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/control"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/httpapi"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/lease"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/splice"
	"github.com/guoyang1982/forge-agent/services/forge-relay/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		log.Error("invalid relay configuration", "error", err)
		os.Exit(2)
	}
	if cfg.DatabaseURL == "" {
		log.Error("FORGE_RELAY_DATABASE_URL is required")
		os.Exit(2)
	}
	database, err := store.Open(context.Background(), cfg.DatabaseURL)
	if err != nil {
		log.Error("database initialization failed", "error", err)
		os.Exit(1)
	}
	defer database.Close()
	if slices.Equal(os.Args[1:], []string{"migrate", "up"}) {
		if err := database.Migrator().Up(context.Background()); err != nil {
			log.Error("database migration failed", "error", err)
			os.Exit(1)
		}
		log.Info("database migrations applied")
		return
	}
	if err := cfg.ValidateRuntime(); err != nil {
		log.Error("invalid relay runtime configuration", "error", err)
		os.Exit(2)
	}
	if err := database.Ping(context.Background()); err != nil {
		log.Error("database is unavailable", "error", err)
		os.Exit(1)
	}
	signer, err := auth.LoadSigner(cfg.PublicOrigin, cfg.JWTPrivateKeyFile)
	if err != nil {
		log.Error("JWT signer initialization failed", "error", err)
		os.Exit(1)
	}

	hosts := lease.NewRegistry(cfg.MaxHosts)
	api := httpapi.New(cfg, log, hosts)
	relaySplicer := splice.New(splice.Config{MaxFrameBytes: cfg.MaxFrameBytes, WriteTimeout: 5 * time.Second}, api.Metrics())
	broker := control.NewBroker(hosts, relaySplicer, cfg.AttachTimeout)
	api.EnableRelayRoutes(httpapi.RelayDependencies{Store: database, Signer: signer, Broker: broker})
	server := &http.Server{
		Addr:              cfg.ListenAddress,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		api.SetReady(false)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Error("relay shutdown failed", "error", err)
		}
	}()

	log.Info("forge relay starting", "config", cfg.String())
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("relay stopped unexpectedly", "error", err)
		os.Exit(1)
	}
}
