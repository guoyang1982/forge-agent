import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import {
  captureCompositeCheckpoint,
  verifyCompositeCheckpoint,
} from "./composite-checkpoint.js";
import { WorkspaceGroupService } from "./groups.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("composite checkpoints", () => {
  it("captures commit, branch, dirty diff hash and validation refs per workspace", async () => {
    const fixture = await groupFixture();
    const result = await captureCompositeCheckpoint(fixture.input);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "frontend",
          headSha: expect.any(String),
          dirty: true,
          diffHash: expect.any(String),
          validationRefs: ["validation:frontend"],
        }),
        expect.objectContaining({
          workspaceId: "backend",
          headSha: expect.any(String),
          dirty: false,
          diffHash: null,
          validationRefs: [],
        }),
      ]),
    );
  });

  it("verifies an unchanged composite checkpoint", async () => {
    const fixture = await groupFixture();
    const captured = await captureCompositeCheckpoint(fixture.input);
    const verified = await verifyCompositeCheckpoint(captured, fixture.input.bindings);
    expect(verified.ok).toBe(true);
    expect(verified.mismatches).toEqual([]);
  });

  it("reports mismatches when a workspace becomes dirty", async () => {
    const fixture = await groupFixture();
    const captured = await captureCompositeCheckpoint(fixture.input);
    writeFileSync(join(fixture.paths.backend, "dirty.txt"), "changed\n");
    const verified = await verifyCompositeCheckpoint(captured, fixture.input.bindings);
    expect(verified.ok).toBe(false);
    expect(verified.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: "backend", field: "dirty" }),
      ]),
    );
  });

  it("handles missing and non-git workspaces read-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-composite-missing-"));
    fixtureRoots.push(root);
    const missingPath = join(root, "missing");
    const plainPath = join(root, "plain");
    mkdirSync(plainPath, { recursive: true });

    const result = await captureCompositeCheckpoint({
      groupId: "group-1",
      bindings: [
        { workspaceId: "missing", rootPath: missingPath },
        { workspaceId: "plain", rootPath: plainPath },
      ],
    });

    expect(result.entries).toEqual([
      {
        workspaceId: "missing",
        headSha: null,
        branch: null,
        dirty: false,
        diffHash: null,
        validationRefs: [],
      },
      {
        workspaceId: "plain",
        headSha: null,
        branch: null,
        dirty: false,
        diffHash: null,
        validationRefs: [],
      },
    ]);
  });

  it("persists composite checkpoints when a database is provided", async () => {
    const fixture = await groupFixture();
    const store = ForgeStore.open({
      dbPath: join(fixture.root, "data.db"),
      migrationsDir,
      owner: "test",
    });
    try {
      const groups = new WorkspaceGroupService(store.db);
      groups.createGroup({ id: "group-1", name: "delivery" });
      const captured = await captureCompositeCheckpoint({
        ...fixture.input,
        runId: "run-1",
        db: store.db,
      });
      const row = store.db
        .prepare(
          `SELECT id, group_id, snapshot_json
           FROM core_workspace_composite_checkpoints
           WHERE id = ?`,
        )
        .get(captured.id) as { id: string; group_id: string; snapshot_json: string };
      expect(row.group_id).toBe("group-1");
      expect(JSON.parse(row.snapshot_json).entries).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

async function groupFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-composite-checkpoint-"));
  fixtureRoots.push(root);
  const frontend = join(root, "frontend");
  const backend = join(root, "backend");
  initRepo(frontend, "frontend.txt", "frontend base\n");
  initRepo(backend, "backend.txt", "backend base\n");
  writeFileSync(join(frontend, "frontend.txt"), "frontend dirty\n");

  return {
    root,
    paths: { frontend, backend },
    input: {
      groupId: "group-1",
      bindings: [
        {
          workspaceId: "frontend",
          rootPath: frontend,
          validationRefs: ["validation:frontend"],
        },
        {
          workspaceId: "backend",
          rootPath: backend,
        },
      ],
    },
  };
}

function initRepo(dir: string, filename: string, contents: string) {
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-b", "main"]);
  runGit(dir, ["config", "user.email", "forge@example.com"]);
  runGit(dir, ["config", "user.name", "Forge"]);
  writeFileSync(join(dir, filename), contents);
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "-m", "init"]);
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}
