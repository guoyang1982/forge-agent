import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import {
  GovernedMemoryStore,
  type MemoryCandidateInput,
  type RecallContext,
} from "./governed-memory.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("GovernedMemoryStore", () => {
  it("rejects new memories without an explicit tenant scope", () => {
    const store = governedMemoryFixture();
    expect(() =>
      store.propose({
        ...candidate("unscoped memory"),
        scope: { employeeId: "e1" },
      }),
    ).toThrow(/tenant scope/i);
  });

  it("does not expose a candidate before an ADD decision", () => {
    const store = governedMemoryFixture();
    store.propose(candidate("prefer concise answers"));
    expect(store.recall(recallContext())).toEqual([]);
  });

  it("recalls approved memories with explanation", () => {
    const store = governedMemoryFixture();
    const proposed = store.propose(candidate("prefer concise answers"));
    store.decide({ candidateId: proposed.id, decision: "ADD" });
    const recalled = store.recall(recallContext());
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({
      content: "prefer concise answers",
      reasonRecalled: expect.stringContaining("approved"),
      confidence: expect.any(Number),
    });
  });

  it("excludes expired and cross-company memories", () => {
    const store = governedMemoryFixtureWithApprovedRows();
    expect(
      store.recall({
        tenantId: "tenant-b",
        organizationId: "org-a",
        employeeId: "e1",
        now: new Date().toISOString(),
      }),
    ).toEqual([]);
    expect(
      store.recall({
        tenantId: "tenant-a",
        organizationId: "org-a",
        employeeId: "e1",
        now: new Date().toISOString(),
      }),
    ).toHaveLength(1);

    const expired = store.propose({
      ...candidate("short-lived note"),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    store.decide({ candidateId: expired.id, decision: "ADD" });
    expect(
      store.recall({
        tenantId: "tenant-a",
        organizationId: "org-a",
        employeeId: "e1",
        now: new Date().toISOString(),
      }),
    ).toHaveLength(1);
  });

  it("applies UPDATE as a new version and supersedes the previous one", () => {
    const store = governedMemoryFixture();
    const first = store.propose(candidate("prefer short answers"));
    store.decide({ candidateId: first.id, decision: "ADD" });
    const correction = store.propose({
      ...candidate("prefer concise answers"),
      targetMemoryId: first.id,
    });
    store.decide({
      candidateId: correction.id,
      decision: "UPDATE",
      memoryId: first.id,
    });
    const recalled = store.recall(recallContext());
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.content).toBe("prefer concise answers");
    expect(recalled[0]?.versionId).toBe(correction.id);
  });

  it("removes memories after DELETE decision", () => {
    const store = governedMemoryFixture();
    const proposed = store.propose(candidate("archive old preference"));
    store.decide({ candidateId: proposed.id, decision: "ADD" });
    const removal = store.propose({
      ...candidate("archive old preference"),
      targetMemoryId: proposed.id,
    });
    store.decide({
      candidateId: removal.id,
      decision: "DELETE",
      memoryId: proposed.id,
    });
    expect(store.recall(recallContext())).toEqual([]);
  });

  it("ignores NOOP decisions", () => {
    const store = governedMemoryFixture();
    const proposed = store.propose(candidate("maybe useful"));
    store.decide({ candidateId: proposed.id, decision: "NOOP" });
    expect(store.recall(recallContext())).toEqual([]);
  });

  it("rejects raw shared cross-user conversations without redaction", () => {
    const store = governedMemoryFixture();
    expect(() =>
      store.propose({
        claim: "User A told user B the launch date",
        scope: {
          tenantId: "tenant-a",
          organizationId: "org-a",
          shared: true,
        },
        sourceKind: "conversation",
        sourceRef: "run:1",
      }),
    ).toThrow(/redact/i);
  });

  it("does not recall project-scoped memories without project context", () => {
    const store = governedMemoryFixture();
    const proposed = store.propose({
      ...candidate("project launch date"),
      scope: {
        tenantId: "tenant-a",
        organizationId: "org-a",
        employeeId: "e1",
        projectId: "project-1",
      },
    });
    store.decide({ candidateId: proposed.id, decision: "ADD" });
    expect(store.recall(recallContext())).toEqual([]);
    expect(
      store.recall({ ...recallContext(), projectId: "project-1" }),
    ).toHaveLength(1);
  });

  it("rejects concurrent decide attempts with compare-and-swap", () => {
    const store = governedMemoryFixture();
    const proposed = store.propose(candidate("single decision"));
    store.decide({ candidateId: proposed.id, decision: "ADD" });
    expect(() =>
      store.decide({ candidateId: proposed.id, decision: "DELETE" }),
    ).toThrow(/already decided/);
  });

  it("does not recall memories from another organization in the same tenant", () => {
    const store = governedMemoryFixtureWithApprovedRows();
    expect(
      store.recall({
        tenantId: "tenant-a",
        organizationId: "org-b",
        employeeId: "e1",
      }),
    ).toEqual([]);
  });

  it("rejects cross-tenant updates and invalidation", () => {
    const store = governedMemoryFixtureWithApprovedRows();
    const original = store.recall(recallContext())[0]!;

    expect(() =>
      store.propose({
        ...candidate("tenant-b replacement"),
        scope: {
          tenantId: "tenant-b",
          organizationId: "org-a",
          employeeId: "e1",
        },
        targetMemoryId: original.memoryId,
      }),
    ).toThrow(/scope/i);
    expect(() =>
      store.invalidate(original.memoryId, {
        tenantId: "tenant-b",
        organizationId: "org-a",
      }),
    ).toThrow(/scope/i);
    expect(store.recall(recallContext())).toHaveLength(1);
  });

  it("rejects DELETE that targets another tenant's memoryId", () => {
    const store = governedMemoryFixtureWithApprovedRows();
    const original = store.recall(recallContext())[0]!;
    const foreign = store.propose({
      ...candidate("tenant-b candidate"),
      scope: {
        tenantId: "tenant-b",
        organizationId: "org-a",
        employeeId: "e1",
      },
    });

    expect(() =>
      store.decide({
        candidateId: foreign.id,
        decision: "DELETE",
        memoryId: original.memoryId,
      }),
    ).toThrow(/scope/i);
    expect(store.recall(recallContext())).toHaveLength(1);
  });

  it("ignores reserved metadata keys supplied by callers", () => {
    const store = governedMemoryFixture();
    const proposed = store.propose({
      ...candidate("protected metadata"),
      metadata: {
        memoryId: "forged-memory",
        version: 99,
        superseded: true,
        note: "allowed",
      },
    });
    expect(proposed.memoryId).not.toBe("forged-memory");
    expect(proposed.version).not.toBe(99);
    store.decide({ candidateId: proposed.id, decision: "ADD" });
    expect(store.recall(recallContext())).toEqual([
      expect.objectContaining({
        content: "protected metadata",
        reasonRecalled: expect.stringContaining("approved"),
      }),
    ]);
  });

  it("invalidates all versions of a memory", () => {
    const store = governedMemoryFixture();
    const proposed = store.propose(candidate("temporary note"));
    store.decide({ candidateId: proposed.id, decision: "ADD" });
    store.invalidate(proposed.id, {
      tenantId: "tenant-a",
      organizationId: "org-a",
    });
    expect(store.recall(recallContext())).toEqual([]);
  });
});

function governedMemoryFixture(): GovernedMemoryStore {
  const root = mkdtempSync(join(tmpdir(), "forge-governed-memory-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  return new GovernedMemoryStore(forgeStore.db);
}

function governedMemoryFixtureWithApprovedRows(): GovernedMemoryStore {
  const store = governedMemoryFixture();
  const proposed = store.propose({
    ...candidate("company-a playbook"),
    scope: {
      tenantId: "tenant-a",
      organizationId: "org-a",
      employeeId: "e1",
    },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  store.decide({ candidateId: proposed.id, decision: "ADD" });
  return store;
}

function candidate(claim: string): MemoryCandidateInput {
  return {
    claim,
    scope: {
      tenantId: "tenant-a",
      organizationId: "org-a",
      employeeId: "e1",
    },
    sourceKind: "agent_inference",
    sourceRef: "run:test",
    evidenceIds: ["evidence-1"],
  };
}

function recallContext(): RecallContext {
  return {
    tenantId: "tenant-a",
    organizationId: "org-a",
    employeeId: "e1",
    now: new Date().toISOString(),
  };
}
