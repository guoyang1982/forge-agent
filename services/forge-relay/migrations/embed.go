package migrationfiles

import "embed"

// Files contains the immutable, reviewed Relay schema migrations.
//
//go:embed *.sql
var Files embed.FS
