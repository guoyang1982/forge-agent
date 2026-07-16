package store

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	migrationfiles "github.com/guoyang1982/forge-agent/services/forge-relay/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Migrator struct{ pool *pgxpool.Pool }

func NewMigrator(pool *pgxpool.Pool) *Migrator { return &Migrator{pool: pool} }

func (m *Migrator) Up(ctx context.Context) error {
	if _, err := m.pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS relay_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`); err != nil {
		return fmt.Errorf("create migration table: %w", err)
	}
	entries, err := fs.ReadDir(migrationfiles.Files, ".")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		if err := m.apply(ctx, entry.Name()); err != nil {
			return err
		}
	}
	return nil
}

func (m *Migrator) apply(ctx context.Context, version string) error {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM relay_schema_migrations WHERE version = $1)", version).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return tx.Commit(ctx)
	}
	data, err := migrationfiles.Files.ReadFile(version)
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return errors.New("empty migration " + version)
	}
	if _, err := tx.Exec(ctx, string(data)); err != nil {
		return fmt.Errorf("apply migration %s: %w", version, err)
	}
	if _, err := tx.Exec(ctx, "INSERT INTO relay_schema_migrations(version) VALUES ($1)", version); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
