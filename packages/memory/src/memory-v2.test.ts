import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import {
  MemoryStoreV2,
  type MemoryCandidateInput,
  type RecallContext,
} from "./memory-v2.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("MemoryStoreV2", () => {
  it("does not expose a candidate before an ADD decision", () => {
    const store = memoryV2Fixture();
    store.propose(candidate("prefer concise answers"));
    expect(store.recall(recallContext())).toEqual([]);
  });

  it("recalls approved memories with explanation", () => {
    const store = memoryV2Fixture();
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
    const store = memoryV2FixtureWithApprovedRows();
    expect(
      store.recall({
        companyId: "company-b",
        employeeId: "e1",
        now: new Date().toISOString(),
      }),
    ).toEqual([]);
    expect(
      store.recall({
        companyId: "company-a",
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
        companyId: "company-a",
        employeeId: "e1",
        now: new Date().toISOString(),
      }),
    ).toHaveLength(1);
  });

  it("applies UPDATE as a new version and supersedes the previous one", () => {
    const store = memoryV2Fixture();
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
    const store = memoryV2Fixture();
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
    const store = memoryV2Fixture();
    const proposed = store.propose(candidate("maybe useful"));
    store.decide({ candidateId: proposed.id, decision: "NOOP" });
    expect(store.recall(recallContext())).toEqual([]);
  });

  it("rejects raw shared cross-user conversations without redaction", () => {
    const store = memoryV2Fixture();
    expect(() =>
      store.propose({
        claim: "User A told user B the launch date",
        scope: { companyId: "company-a", shared: true },
        sourceKind: "conversation",
        sourceRef: "run:1",
      }),
    ).toThrow(/redact/i);
  });

  it("does not recall project-scoped memories without project context", () => {
    const store = memoryV2Fixture();
    const proposed = store.propose({
      ...candidate("project launch date"),
      scope: {
        companyId: "company-a",
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
    const store = memoryV2Fixture();
    const proposed = store.propose(candidate("single decision"));
    store.decide({ candidateId: proposed.id, decision: "ADD" });
    expect(() =>
      store.decide({ candidateId: proposed.id, decision: "DELETE" }),
    ).toThrow(/already decided/);
  });

  it("ignores reserved metadata keys supplied by callers", () => {
    const store = memoryV2Fixture();
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
    const store = memoryV2Fixture();
    const proposed = store.propose(candidate("temporary note"));
    store.decide({ candidateId: proposed.id, decision: "ADD" });
    store.invalidate(proposed.id);
    expect(store.recall(recallContext())).toEqual([]);
  });
});

function memoryV2Fixture(): MemoryStoreV2 {
  const root = mkdtempSync(join(tmpdir(), "forge-memory-v2-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  return new MemoryStoreV2(forgeStore.db);
}

function memoryV2FixtureWithApprovedRows(): MemoryStoreV2 {
  const store = memoryV2Fixture();
  const proposed = store.propose({
    ...candidate("company-a playbook"),
    scope: { companyId: "company-a", employeeId: "e1" },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  store.decide({ candidateId: proposed.id, decision: "ADD" });
  return store;
}

function candidate(claim: string): MemoryCandidateInput {
  return {
    claim,
    scope: { companyId: "company-a", employeeId: "e1" },
    sourceKind: "agent_inference",
    sourceRef: "run:test",
    evidenceIds: ["evidence-1"],
  };
}

function recallContext(): RecallContext {
  return {
    companyId: "company-a",
    employeeId: "e1",
    now: new Date().toISOString(),
  };
}
