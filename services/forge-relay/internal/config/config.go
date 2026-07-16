package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddress         string
	PublicOrigin          string
	DatabaseURL           string
	EnrollToken           string
	JWTPrivateKeyFile     string
	MaxHosts              int
	MaxConnectionsPerHost int
	MaxFrameBytes         int64
	HostLeaseDuration     time.Duration
	AttachTimeout         time.Duration
	ShutdownTimeout       time.Duration
}

func Load() (Config, error) {
	cfg := Config{
		ListenAddress:         env("FORGE_RELAY_LISTEN_ADDRESS", ":8080"),
		PublicOrigin:          strings.TrimRight(env("FORGE_RELAY_PUBLIC_ORIGIN", "http://127.0.0.1:8080"), "/"),
		DatabaseURL:           os.Getenv("FORGE_RELAY_DATABASE_URL"),
		EnrollToken:           os.Getenv("FORGE_RELAY_ENROLL_TOKEN"),
		JWTPrivateKeyFile:     os.Getenv("FORGE_RELAY_JWT_PRIVATE_KEY_FILE"),
		MaxHosts:              envInt("FORGE_RELAY_MAX_HOSTS", 100),
		MaxConnectionsPerHost: envInt("FORGE_RELAY_MAX_CONNECTIONS_PER_HOST", 8),
		MaxFrameBytes:         int64(envInt("FORGE_RELAY_MAX_FRAME_BYTES", 1_048_576)),
		HostLeaseDuration:     envDuration("FORGE_RELAY_HOST_LEASE_DURATION", 60*time.Second),
		AttachTimeout:         envDuration("FORGE_RELAY_ATTACH_TIMEOUT", 10*time.Second),
		ShutdownTimeout:       envDuration("FORGE_RELAY_SHUTDOWN_TIMEOUT", 10*time.Second),
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) ValidateRuntime() error {
	if c.DatabaseURL == "" {
		return errors.New("FORGE_RELAY_DATABASE_URL is required")
	}
	if len(c.EnrollToken) < 32 {
		return errors.New("FORGE_RELAY_ENROLL_TOKEN must contain at least 32 characters")
	}
	if c.JWTPrivateKeyFile == "" {
		return errors.New("FORGE_RELAY_JWT_PRIVATE_KEY_FILE is required")
	}
	return nil
}

func (c Config) Validate() error {
	if c.ListenAddress == "" {
		return errors.New("FORGE_RELAY_LISTEN_ADDRESS must not be empty")
	}
	origin, err := url.Parse(c.PublicOrigin)
	if err != nil || origin.Scheme == "" || origin.Host == "" || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return errors.New("FORGE_RELAY_PUBLIC_ORIGIN must be a canonical origin without path, query, or fragment")
	}
	if origin.Scheme != "https" && origin.Hostname() != "127.0.0.1" && origin.Hostname() != "localhost" {
		return errors.New("FORGE_RELAY_PUBLIC_ORIGIN must use https outside localhost")
	}
	if c.MaxHosts < 1 || c.MaxConnectionsPerHost < 1 {
		return errors.New("host and connection limits must be positive")
	}
	if c.MaxFrameBytes < 1024 || c.MaxFrameBytes > 16*1024*1024 {
		return errors.New("FORGE_RELAY_MAX_FRAME_BYTES must be between 1 KiB and 16 MiB")
	}
	if c.HostLeaseDuration < 15*time.Second || c.AttachTimeout < time.Second {
		return errors.New("lease and attach timeouts are too short")
	}
	return nil
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func (c Config) String() string {
	return fmt.Sprintf("listen=%s origin=%s max_hosts=%d max_connections_per_host=%d max_frame_bytes=%d", c.ListenAddress, c.PublicOrigin, c.MaxHosts, c.MaxConnectionsPerHost, c.MaxFrameBytes)
}
