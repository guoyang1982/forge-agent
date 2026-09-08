import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { WorkspaceGroupService } from "./groups.js";
import { WorkspaceConflictError, WorkspaceLeaseService } from "./leases.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WorkspaceLeaseService", () => {
  it("allows write leases for different workspaces", () => {
    const { leases, frontend, backend } = leaseFixture();
    expect(leases.acquire(writeLease(frontend, "run-a"))).toBeTruthy();
    expect(leases.acquire(writeLease(backend, "run-b"))).toBeTruthy();
  });

  it("rejects a second active writer for the same workspace", () => {
    const { leases, frontend } = leaseFixture();
    leases.acquire(writeLease(frontend, "run-a"));
    expect(() => leases.acquire(writeLease(frontend, "run-b"))).toThrow(WorkspaceConflictError);
  });

  it("renews and releases an active lease", () => {
    const { leases, frontend } = leaseFixture();
    const lease = leases.acquire(writeLease(frontend, "run-a"));
    const renewed = leases.renew(lease.id, "2026-01-01T02:00:00.000Z");
    expect(renewed.expiresAt).toBe("2026-01-01T02:00:00.000Z");

    const released = leases.release(lease.id, "step finished");
    expect(released.releasedAt).toBeTruthy();
    expect(released.releasedReason).toBe("step finished");
  });

  it("rejects leases when the requested root path does not match registration", () => {
    const { leases, frontend, backend } = leaseFixture();
    expect(() =>
      leases.acquire({
        ...writeLease(frontend, "run-a"),
        rootPath: backend.rootPath,
      }),
    ).toThrow(WorkspaceConflictError);
  });

  it("reclaims an expired write lease so a later acquire can proceed", () => {
    const { leases, frontend } = leaseFixture();
    const expired = leases.acquire({
      ...writeLease(frontend, "run-a"),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(leases.reclaimExpired("2026-01-01T00:00:00.000Z")).toEqual([expired.id]);
    expect(leases.acquire(writeLease(frontend, "run-b")).runId).toBe("run-b");
  });

  it("does not steal an expired write lease while the holder attempt is still running", () => {
    const { store, leases, frontend } = leaseFixture();
    insertAttempt(store, { id: "attempt-live", state: "running" });
    leases.acquire({
      ...writeLease(frontend, "run-a"),
      attemptId: "attempt-live",
      stepId: "step-1",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    expect(leases.reclaimExpired("2026-01-01T00:00:00.000Z")).toEqual([]);
    expect(() => leases.acquire(writeLease(frontend, "run-b"))).toThrow(
      WorkspaceConflictError,
    );
  });

  it("reclaims an expired write lease after the holder attempt has stopped", () => {
    const { store, leases, frontend } = leaseFixture();
    insertAttempt(store, { id: "attempt-dead", state: "abandoned" });
    const expired = leases.acquire({
      ...writeLease(frontend, "run-a"),
      attemptId: "attempt-dead",
      stepId: "step-1",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    expect(leases.reclaimExpired("2026-01-01T00:00:00.000Z")).toEqual([expired.id]);
    expect(leases.acquire(writeLease(frontend, "run-b")).runId).toBe("run-b");
  });
});

function leaseFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-workspace-leases-"));
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
    leases: new WorkspaceLeaseService(store.db),
    frontend,
    backend,
  };
}

function writeLease(
  workspace: { id: string; rootPath: string },
  runId: string,
) {
  return {
    workspaceId: workspace.id,
    runId,
    mode: "write" as const,
    rootPath: workspace.rootPath,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function insertAttempt(
  store: ForgeStore,
  input: { id: string; state: "running" | "abandoned" },
): void {
  const now = "2026-01-01T00:00:00.000Z";
  store.db
    .prepare(
      `INSERT INTO core_runs (
         id, state, spec_json, correlation_id, requested_by_json, created_at, updated_at
       ) VALUES ('run-a', 'running', '{}', 'corr-1', '{}', ?, ?)`,
    )
    .run(now, now);
  store.db
    .prepare(
      `INSERT INTO core_steps (
         id, run_id, kind, state, retry_json, timeout_ms, created_at, updated_at
       ) VALUES ('step-1', 'run-a', 'test', 'running', '{}', 3600000, ?, ?)`,
    )
    .run(now, now);
  store.db
    .prepare(
      `INSERT INTO core_attempts (
         id, run_id, step_id, attempt_number, state, input_json, created_at, updated_at
       ) VALUES (?, 'run-a', 'step-1', 1, ?, '{}', ?, ?)`,
    )
    .run(input.id, input.state, now, now);
}
