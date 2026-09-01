import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetRegistry } from "@forge/asset-registry";
import { ForgeStore } from "@forge/store";
import { WorkflowStore } from "./store.js";
import type { DurableWorkflowDefinition } from "./types.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WorkflowStore", () => {
  it("publishes a workflow through AssetRegistry", () => {
    const store = workflowFixture();
    const published = store.publish(
      {
        id: "wf-1",
        name: "Launch workflow",
        ownerSubject: { kind: "human", id: "local" },
        definition: sampleDefinition(),
      },
      {
        validationIds: ["validation-pass"],
        permissionReviewed: true,
        securityValidationId: "security-pass",
      },
    );

    expect(published.asset.kind).toBe("workflow");
    expect(published.assetVersion.state).toBe("published");
    expect(published.definition.id).toBe("wf-1");
    expect(store.getPublishedDefinition("wf-1").version).toBe(1);
  });

  it("enforces workflow concurrency limits", () => {
    const store = workflowFixture();
    const published = store.publish(
      {
        id: "wf-1",
        name: "Launch workflow",
        ownerSubject: { kind: "human", id: "local" },
        definition: sampleDefinition({ concurrency: { maxRuns: 1 } }),
      },
      publishGate(),
    );

    store.createInstance({
      workflowId: "wf-1",
      workflowVersionId: published.workflowVersionId,
      triggerKind: "manual",
      runInput: { topic: "launch" },
    });

    expect(store.canStartInstance("wf-1")).toBe(false);
    expect(() =>
      store.createInstance({
        workflowId: "wf-1",
        workflowVersionId: published.workflowVersionId,
        triggerKind: "manual",
        runInput: { topic: "launch" },
      }),
    ).toThrow(/concurrency limit/);
  });

  it("tracks dead-letter instances", () => {
    const store = workflowFixture();
    const published = store.publish(
      {
        id: "wf-1",
        name: "Launch workflow",
        ownerSubject: { kind: "human", id: "local" },
        definition: sampleDefinition(),
      },
      publishGate(),
    );

    const instance = store.createInstance({
      workflowId: "wf-1",
      workflowVersionId: published.workflowVersionId,
      triggerKind: "manual",
      runInput: { topic: "launch" },
    });

    const deadLetter = store.markDeadLetter(instance.id, "step failed");
    expect(deadLetter.state).toBe("dead_letter");
    expect(deadLetter.input).toMatchObject({
      topic: "launch",
      deadLetterReason: "step failed",
    });
    expect(store.listDeadLetters("wf-1")).toHaveLength(1);
  });
});

function workflowFixture(): WorkflowStore {
  const root = mkdtempSync(join(tmpdir(), "forge-workflow-store-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const assets = new AssetRegistry(forgeStore.db);
  return new WorkflowStore(forgeStore.db, assets);
}

function sampleDefinition(
  overrides: Partial<DurableWorkflowDefinition> = {},
): DurableWorkflowDefinition {
  return {
    id: "wf-1",
    version: 1,
    inputSchema: {
      type: "object",
      required: ["topic"],
      properties: { topic: { type: "string" } },
    },
    steps: [
      { id: "research", kind: "research", dependsOn: [], input: {} },
      { id: "draft", kind: "draft", dependsOn: ["research"], input: {} },
      { id: "approve", kind: "approve", dependsOn: ["draft"], input: {} },
    ],
    triggers: [{ kind: "manual" }],
    concurrency: { maxRuns: 1 },
    ...overrides,
  };
}

function publishGate() {
  return {
    validationIds: ["validation-pass"],
    permissionReviewed: true,
    securityValidationId: "security-pass",
  };
}
