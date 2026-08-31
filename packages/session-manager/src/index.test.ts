import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNonMigratingDatabase } from "@forge/store";
import {
  SessionManager,
  type SessionManagerOptions,
  formatSessionsList,
} from "./index.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("SessionManager", () => {
  it("opens the shared database without applying migrations", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "forge-session-manager-"));
    fixtureRoots.push(dataDir);
    const migrationsDir = join(dataDir, "migrations");
    mkdirSync(migrationsDir);
    writeFileSync(
      join(migrationsDir, "001_must_not_run.sql"),
      "CREATE TABLE must_not_exist (id INTEGER PRIMARY KEY);",
    );

    const manager = new SessionManager({
      dataDir,
      migrationsDir,
    } as SessionManagerOptions);
    manager.close();

    const db = openNonMigratingDatabase(join(dataDir, "data.db"));
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

describe("formatSessionsList", () => {
  it("marks the active session and includes previews", () => {
    const out = formatSessionsList(
      [
        {
          id: "abcdef123456",
          cwd: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          messageCount: 3,
          lastPreview: "latest user request",
        },
      ],
      "abcdef123456",
    );

    expect(out).toContain("* abcdef12");
    expect(out).toContain("3 msgs");
    expect(out).toContain("latest user request");
  });
});
