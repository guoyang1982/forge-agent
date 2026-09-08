import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertForeignKeysEnabled,
  ForgeStore,
  openNonMigratingDatabase,
  type ForgeStoreOptions,
} from "./index.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ForgeStore migrations", () => {
  it("enables foreign_keys on every connection", () => {
    const fixture = migrationFixture({
      "001_init.sql": "CREATE TABLE noop (id INTEGER PRIMARY KEY);",
    });
    const store = ForgeStore.open(fixture.options);
    try {
      assertForeignKeysEnabled(store.db);
    } finally {
      store.close();
    }
  });

  it("rejects migration ownership outside daemon or tests", () => {
    const fixture = migrationFixture({});
    expect(() =>
      ForgeStore.open({ ...fixture.options, owner: "channel" as never }),
    ).toThrow(/migration owner/i);
  });

  it("records every migration once and does not repeat its effects", () => {
    const fixture = migrationFixture({
      "001_init.sql": `
        CREATE TABLE effects (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);
        INSERT INTO effects (label) VALUES ('first-apply');
      `,
      "002_next.sql": "CREATE TABLE next_feature (id INTEGER PRIMARY KEY);",
    });

    ForgeStore.open(fixture.options).close();
    const reopened = ForgeStore.open(fixture.options);
    try {
      expect(
        reopened.db
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: "001_init.sql" },
        { version: "002_next.sql" },
      ]);
      expect(
        reopened.db.prepare("SELECT COUNT(*) AS count FROM effects").get(),
      ).toEqual({ count: 1 });
    } finally {
      reopened.close();
    }
  });

  it("adopts an idempotent migration already present in a legacy database", () => {
    const fixture = migrationFixture({
      "001_init.sql": `
        CREATE TABLE IF NOT EXISTS legacy_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT OR IGNORE INTO legacy_data (id, value) VALUES (1, 'kept');
      `,
    });
    const legacy = new Database(fixture.options.dbPath);
    legacy.exec(`
      CREATE TABLE legacy_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO legacy_data (id, value) VALUES (1, 'kept');
    `);
    legacy.close();

    const store = ForgeStore.open(fixture.options);
    try {
      expect(store.db.prepare("SELECT * FROM legacy_data").all()).toEqual([
        { id: 1, value: "kept" },
      ]);
      expect(
        store.db.prepare("SELECT version FROM schema_migrations").all(),
      ).toEqual([{ version: "001_init.sql" }]);
    } finally {
      store.close();
    }
  });

  it("fails closed when an applied migration checksum changes", () => {
    const fixture = migrationFixture({
      "001_init.sql": "CREATE TABLE stable_data (id INTEGER PRIMARY KEY);",
    });
    ForgeStore.open(fixture.options).close();

    fixture.replaceSql(
      "001_init.sql",
      "CREATE TABLE changed_data (id INTEGER PRIMARY KEY);",
    );

    expect(() => ForgeStore.open(fixture.options)).toThrow(
      /checksum mismatch.*001_init\.sql/i,
    );
    const db = new Database(fixture.options.dbPath, { readonly: true });
    try {
      expect(
        db.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'changed_data'",
        ).get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("rolls back migration effects and its journal row together", () => {
    const fixture = migrationFixture({
      "001_init.sql": "CREATE TABLE effects (value TEXT NOT NULL);",
      "002_broken.sql": `
        INSERT INTO effects (value) VALUES ('must-roll-back');
        INSERT INTO missing_table (value) VALUES ('failure');
      `,
    });

    expect(() => ForgeStore.open(fixture.options)).toThrow(/missing_table/i);
    const db = new Database(fixture.options.dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM effects").get()).toEqual({
        count: 0,
      });
      expect(
        db
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([{ version: "001_init.sql" }]);
    } finally {
      db.close();
    }
  });
});

describe("non-migrating database connections", () => {
  it("opens a read-write database without creating migration state", () => {
    const fixture = migrationFixture({
      "001_init.sql": "CREATE TABLE must_not_exist (id INTEGER PRIMARY KEY);",
    });
    const db = openNonMigratingDatabase(fixture.options.dbPath);
    try {
      expect(
        db.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        ).get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

describe("ForgeStore backup", () => {
  it("creates a checksummed online backup that contains committed data", async () => {
    const fixture = migrationFixture({
      "001_init.sql": `
        CREATE TABLE durable_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO durable_data (id, value) VALUES (1, 'preserved');
      `,
    });
    const store = ForgeStore.open(fixture.options);
    const targetPath = join(fixture.root, "backups", "data.db");
    try {
      const manifest = await store.backup(targetPath);
      expect(manifest).toMatchObject({
        sourcePath: fixture.options.dbPath,
        targetPath,
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      const backup = new Database(targetPath, { readonly: true });
      try {
        expect(backup.prepare("SELECT * FROM durable_data").all()).toEqual([
          { id: 1, value: "preserved" },
        ]);
        expect(
          backup.prepare("SELECT version FROM schema_migrations").all(),
        ).toEqual([{ version: "001_init.sql" }]);
      } finally {
        backup.close();
      }
    } finally {
      store.close();
    }
  });
});

function migrationFixture(files: Record<string, string>): {
  root: string;
  options: ForgeStoreOptions;
  replaceSql: (name: string, sql: string) => void;
} {
  const root = mkdtempSync(join(tmpdir(), "forge-store-"));
  fixtureRoots.push(root);
  const migrationsDir = join(root, "migrations");
  const dataDir = join(root, "data");
  mkdirSync(migrationsDir);
  mkdirSync(dataDir);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(migrationsDir, name), sql, "utf8");
  }
  return {
    root,
    options: {
      dbPath: join(dataDir, "data.db"),
      migrationsDir,
      owner: "test",
    },
    replaceSql: (name, sql) => {
      writeFileSync(join(migrationsDir, name), sql, "utf8");
    },
  };
}
