import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Database } from "@forge/store";
import { WorkspaceConflictError } from "./leases.js";

export interface WorkspaceRecord {
  id: string;
  rootPath: string;
  canonicalRootPath: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceBinding {
  id: string;
  groupId: string;
  workspaceId: string;
  rootPath: string;
  mode: "read" | "write";
  pathScopes: string[];
  createdAt: string;
}

export class WorkspaceGroupService {
  constructor(private readonly db: Database) {}

  registerWorkspace(input: {
    id: string;
    rootPath: string;
    label?: string;
  }): WorkspaceRecord {
    const now = new Date().toISOString();
    const canonicalRootPath = realpathSync.native(input.rootPath);
    const existing = this.db
      .prepare(
        `SELECT id FROM core_workspaces
         WHERE canonical_root_path = ? AND id != ?`,
      )
      .get(canonicalRootPath, input.id) as { id: string } | undefined;
    if (existing) {
      throw new WorkspaceConflictError(
        `canonical root path already registered to workspace ${existing.id}`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO core_workspaces (
          id, root_path, canonical_root_path, label, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          root_path = excluded.root_path,
          canonical_root_path = excluded.canonical_root_path,
          label = excluded.label,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.rootPath,
        canonicalRootPath,
        input.label ?? null,
        now,
        now,
      );
    return {
      id: input.id,
      rootPath: input.rootPath,
      canonicalRootPath,
      label: input.label,
      createdAt: now,
      updatedAt: now,
    };
  }

  createGroup(input: {
    id?: string;
    name: string;
    description?: string;
  }): WorkspaceGroup {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO core_workspace_groups (
          id, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.description ?? null, now, now);
    return {
      id,
      name: input.name,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };
  }

  bindWorkspace(input: {
    id?: string;
    groupId: string;
    workspaceId: string;
    rootPath: string;
    mode: "read" | "write";
    pathScopes?: string[];
  }): WorkspaceBinding {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const canonicalRootPath = realpathSync.native(input.rootPath);
    this.db
      .prepare(
        `INSERT INTO core_workspace_bindings (
          id, group_id, workspace_id, root_path, mode, path_scopes_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.groupId,
        input.workspaceId,
        canonicalRootPath,
        input.mode,
        JSON.stringify(input.pathScopes ?? []),
        now,
      );
    return {
      id,
      groupId: input.groupId,
      workspaceId: input.workspaceId,
      rootPath: canonicalRootPath,
      mode: input.mode,
      pathScopes: input.pathScopes ?? [],
      createdAt: now,
    };
  }

  listBindings(groupId: string): WorkspaceBinding[] {
    const rows = this.db
      .prepare(
        `SELECT id, group_id, workspace_id, root_path, mode, path_scopes_json, created_at
         FROM core_workspace_bindings
         WHERE group_id = ?
         ORDER BY created_at`,
      )
      .all(groupId) as Array<{
      id: string;
      group_id: string;
      workspace_id: string;
      root_path: string;
      mode: "read" | "write";
      path_scopes_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      groupId: row.group_id,
      workspaceId: row.workspace_id,
      rootPath: row.root_path,
      mode: row.mode,
      pathScopes: JSON.parse(row.path_scopes_json) as string[],
      createdAt: row.created_at,
    }));
  }
}
