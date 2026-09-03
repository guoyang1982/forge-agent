import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { WorkspaceGroupService } from "./groups.js";
import { WorkspaceConflictError } from "./leases.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WorkspaceGroupService", () => {
  it("creates a group and binds multiple workspaces with canonical paths", () => {
    const { groups, frontend, backend, close } = groupFixture();
    try {
      const group = groups.createGroup({ id: "group-1", name: "delivery" });
      const frontendBinding = groups.bindWorkspace({
        groupId: group.id,
        workspaceId: frontend.id,
        rootPath: frontend.rootPath,
        mode: "write",
        pathScopes: ["src"],
      });
      const backendBinding = groups.bindWorkspace({
        groupId: group.id,
        workspaceId: backend.id,
        rootPath: backend.rootPath,
        mode: "read",
      });

      expect(groups.listBindings(group.id)).toEqual(
        expect.arrayContaining([frontendBinding, backendBinding]),
      );
      expect(frontendBinding.rootPath).toBe(frontend.canonicalRootPath);
    } finally {
      close();
    }
  });

  it("rejects registering two workspace ids for the same canonical root", () => {
    const { groups, frontend, close } = groupFixture();
    try {
      const aliasPath = join(dirname(frontend.rootPath), "frontend-alias");
      symlinkSync(frontend.rootPath, aliasPath);
      expect(() =>
        groups.registerWorkspace({ id: "frontend-alias", rootPath: aliasPath }),
      ).toThrow(WorkspaceConflictError);
    } finally {
      close();
    }
  });
});

function groupFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-workspace-groups-"));
  fixtureRoots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const frontendPath = join(root, "frontend");
  const backendPath = join(root, "backend");
  mkdirSync(frontendPath, { recursive: true });
  mkdirSync(backendPath, { recursive: true });

  const groups = new WorkspaceGroupService(store.db);
  const frontend = groups.registerWorkspace({ id: "frontend", rootPath: frontendPath });
  const backend = groups.registerWorkspace({ id: "backend", rootPath: backendPath });

  return {
    store,
    groups,
    frontend,
    backend,
    close: () => store.close(),
  };
}
