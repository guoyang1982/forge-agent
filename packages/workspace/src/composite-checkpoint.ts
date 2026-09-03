import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Database } from "@forge/store";

export interface CompositeCheckpointEntry {
  workspaceId: string;
  headSha: string | null;
  branch: string | null;
  dirty: boolean;
  diffHash: string | null;
  validationRefs: string[];
}

export interface CompositeCheckpoint {
  id: string;
  groupId: string;
  entries: CompositeCheckpointEntry[];
  capturedAt: string;
}

export interface CaptureCompositeCheckpointInput {
  id?: string;
  groupId: string;
  runId?: string;
  bindings: Array<{
    workspaceId: string;
    rootPath: string;
    validationRefs?: string[];
  }>;
  db?: Database;
}

export interface CompositeCheckpointMismatch {
  workspaceId: string;
  field: "headSha" | "branch" | "dirty" | "diffHash";
  expected: unknown;
  actual: unknown;
}

export interface VerifyCompositeCheckpointResult {
  ok: boolean;
  mismatches: CompositeCheckpointMismatch[];
}

export async function captureCompositeCheckpoint(
  input: CaptureCompositeCheckpointInput,
): Promise<CompositeCheckpoint> {
  const capturedAt = new Date().toISOString();
  const entries = await Promise.all(input.bindings.map((binding) => collectEntry(binding)));
  const checkpoint: CompositeCheckpoint = {
    id: input.id ?? randomUUID(),
    groupId: input.groupId,
    entries,
    capturedAt,
  };

  if (input.db) {
    input.db
      .prepare(
        `INSERT INTO core_workspace_composite_checkpoints (
          id, group_id, run_id, snapshot_json, captured_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        checkpoint.id,
        checkpoint.groupId,
        input.runId ?? "manual",
        JSON.stringify(checkpoint),
        checkpoint.capturedAt,
      );
  }

  return checkpoint;
}

export async function verifyCompositeCheckpoint(
  checkpoint: CompositeCheckpoint,
  bindings: Array<{ workspaceId: string; rootPath: string }>,
): Promise<VerifyCompositeCheckpointResult> {
  const current = await captureCompositeCheckpoint({
    groupId: checkpoint.groupId,
    bindings,
  });
  const mismatches: CompositeCheckpointMismatch[] = [];

  for (const expected of checkpoint.entries) {
    const actual = current.entries.find((entry) => entry.workspaceId === expected.workspaceId);
    if (!actual) {
      mismatches.push({
        workspaceId: expected.workspaceId,
        field: "headSha",
        expected: expected.headSha,
        actual: null,
      });
      continue;
    }

    for (const field of ["headSha", "branch", "dirty", "diffHash"] as const) {
      if (actual[field] !== expected[field]) {
        mismatches.push({
          workspaceId: expected.workspaceId,
          field,
          expected: expected[field],
          actual: actual[field],
        });
      }
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

async function collectEntry(binding: {
  workspaceId: string;
  rootPath: string;
  validationRefs?: string[];
}): Promise<CompositeCheckpointEntry> {
  const validationRefs = binding.validationRefs ?? [];
  if (!existsSync(binding.rootPath)) {
    return emptyEntry(binding.workspaceId, validationRefs);
  }

  const inRepo = await runGit(binding.rootPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inRepo.ok || inRepo.stdout.trim() !== "true") {
    return emptyEntry(binding.workspaceId, validationRefs);
  }

  const head = await runGit(binding.rootPath, ["rev-parse", "HEAD"]);
  const headSha = head.ok ? head.stdout.trim() : null;
  const branch = await resolveBranch(binding.rootPath);
  const status = await runGit(binding.rootPath, ["status", "--porcelain"]);
  const dirty = status.ok && status.stdout.trim().length > 0;
  const diff = await runGit(binding.rootPath, ["diff", "--no-color", "HEAD"]);
  const diffHash =
    diff.ok && diff.stdout.trim().length > 0
      ? createHash("sha256").update(diff.stdout).digest("hex")
      : null;

  return {
    workspaceId: binding.workspaceId,
    headSha,
    branch,
    dirty,
    diffHash,
    validationRefs,
  };
}

function emptyEntry(
  workspaceId: string,
  validationRefs: string[],
): CompositeCheckpointEntry {
  return {
    workspaceId,
    headSha: null,
    branch: null,
    dirty: false,
    diffHash: null,
    validationRefs,
  };
}

async function resolveBranch(rootPath: string): Promise<string | null> {
  const symbolic = await runGit(rootPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic.ok && symbolic.stdout.trim()) {
    return symbolic.stdout.trim();
  }
  const head = await runGit(rootPath, ["rev-parse", "--short", "HEAD"]);
  if (head.ok && head.stdout.trim()) {
    return `HEAD ${head.stdout.trim()}`;
  }
  return null;
}

function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
    proc.on("error", (error) => {
      resolve({ ok: false, stdout: "", stderr: error.message });
    });
  });
}
