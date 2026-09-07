import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetQualityGateError, AssetRegistry } from "@forge/asset-registry";
import { seedPublishEvidence, seedWorkflowReplayGrant } from "@forge/asset-registry/test-evidence";
import { ForgeStore } from "@forge/store";
import {
  WorkflowReplayAuthorizationError,
  WorkflowStore,
} from "./store.js";
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
    const fx = workflowFixture();
    const published = publishWorkflow(fx, {
      id: "wf-1",
      name: "Launch workflow",
      ownerSubject: { kind: "human", id: "local" },
      definition: sampleDefinition(),
    });

    expect(published.asset.kind).toBe("workflow");
    expect(published.assetVersion.state).toBe("published");
    expect(published.definition.id).toBe("wf-1");
    expect(fx.store.getPublishedDefinition("wf-1").version).toBe(1);
  });

  it("requires explicit quality evidence before publish", () => {
    const fx = workflowFixture();
    expect(() =>
      fx.store.publish(
        {
          id: "wf-1",
          name: "Launch workflow",
          ownerSubject: { kind: "human", id: "local" },
          definition: sampleDefinition(),
        },
        {
          validationIds: ["validation-pass-wf-1"],
          permissionReviewId: "grant:publish:wf-1",
          securityValidationId: "security-pass-wf-1",
        },
      ),
    ).toThrow(AssetQualityGateError);
  });

  it("republishes atomically with the next workflow version", () => {
    const fx = workflowFixture();
    const first = publishWorkflow(fx, {
      id: "wf-1",
      name: "Launch workflow",
      ownerSubject: { kind: "human", id: "local" },
      definition: sampleDefinition(),
    });
    const second = publishWorkflow(fx, {
      id: "wf-1",
      name: "Launch workflow",
      ownerSubject: { kind: "human", id: "local" },
      definition: sampleDefinition({ concurrency: { maxRuns: 2 } }),
    });

    expect(second.definition.version).toBe(2);
    expect(fx.store.getPublishedDefinition("wf-1").concurrency.maxRuns).toBe(2);
    expect(fx.store.getLatestPublishedVersion("wf-1")?.workflowVersionId).toBe(
      second.workflowVersionId,
    );
    expect(first.asset.id).toBe(second.asset.id);
  });

  it("enforces workflow concurrency limits", () => {
    const fx = workflowFixture();
    const published = publishWorkflow(fx, {
      id: "wf-1",
      name: "Launch workflow",
      ownerSubject: { kind: "human", id: "local" },
      definition: sampleDefinition({ concurrency: { maxRuns: 1 } }),
    });

    fx.store.createInstance({
      workflowId: "wf-1",
      workflowVersionId: published.workflowVersionId,
      triggerKind: "manual",
      runInput: { topic: "launch" },
    });

    expect(fx.store.canStartInstance("wf-1")).toBe(false);
    expect(() =>
      fx.store.createInstance({
        workflowId: "wf-1",
        workflowVersionId: published.workflowVersionId,
        triggerKind: "manual",
        runInput: { topic: "launch" },
      }),
    ).toThrow(/concurrency limit/);
  });

  it("uses the requested workflow version concurrency limit after republishing", () => {
    const fx = workflowFixture();
    const first = publishWorkflow(fx, {
      id: "wf-versioned-limit",
      name: "Versioned workflow",
      ownerSubject: { kind: "human", id: "local" },
      definition: sampleDefinition({
        id: "wf-versioned-limit",
        concurrency: { maxRuns: 1 },
      }),
    });
    publishWorkflow(fx, {
      id: "wf-versioned-limit",
      name: "Versioned workflow",
      ownerSubject: { kind: "human", id: "local" },
      definition: sampleDefinition({
        id: "wf-versioned-limit",
        concurrency: { maxRuns: 2 },
      }),
    });

    fx.store.createInstance({
      workflowId: "wf-versioned-limit",
      workflowVersionId: first.workflowVersionId,
      triggerKind: "manual",
      runInput: { topic: "first" },
    });
    expect(() =>
      fx.store.createInstance({
        workflowId: "wf-versioned-limit",
        workflowVersionId: first.workflowVersionId,
        triggerKind: "manual",
        runInput: { topic: "second" },
      }),
    ).toThrow(/concurrency limit/);
  });

  it("rejects instances for unpublished workflow versions", () => {
    const fx = workflowFixture();
    const published = publishWorkflow(fx, {
      id: "wf-1",
      name: "Launch workflow",
      ownerSubject: { kind: "human", id: "local" },
      definition: sampleDefinition(),
    });

    expect(() =>
      fx.store.createInstance({
        workflowId: "wf-1",
        workflowVersionId: "missing-version",
        triggerKind: "manual",
        runInput: { topic: "launch" },
      }),
    ).toThrow(/not published/);
    expect(published.workflowVersionId).toBeTruthy();
  });

  it("tracks dead-letter instances", () => {
    const fx = workflowFixture();
    const published = publishWorkflow(fx, {
      id: "wf-1",
      name: "Launch workflow",
      ownerSubject: { kind: "human", id: "local" },
      definition: sampleDefinition(),
    });

    const instance = fx.store.createInstance({
      workflowId: "wf-1",
      workflowVersionId: published.workflowVersionId,
      triggerKind: "manual",
      runInput: { topic: "launch" },
    });

    const deadLetter = fx.store.markDeadLetter(instance.id, "step failed");
    expect(deadLetter.state).toBe("dead_letter");
    expect(deadLetter.input).toMatchObject({
      topic: "launch",
      deadLetterReason: "step failed",
    });
    expect(fx.store.listDeadLetters("wf-1")).toHaveLength(1);
  });

  it("requires authorization to replay a dead-letter instance", () => {
    const fx = workflowFixture();
    const published = publishWorkflow(fx, {
      id: "wf-1",
      name: "Launch workflow",
      ownerSubject: { kind: "human", id: "local" },
      definition: sampleDefinition(),
    });
    const instance = fx.store.createInstance({
      workflowId: "wf-1",
      workflowVersionId: published.workflowVersionId,
      triggerKind: "manual",
      runInput: { topic: "launch" },
    });
    fx.store.markDeadLetter(instance.id, "step failed");

    expect(() =>
      fx.store.replayDeadLetter(instance.id, { kind: "", id: "" }, {
        reason: "retry",
        grantId: "grant:replay:1",
        idempotencyKey: "replay-1",
      }),
    ).toThrow(WorkflowReplayAuthorizationError);

    seedWorkflowReplayGrant(fx.forgeStore.db, "grant:replay:1", {
      instanceId: instance.id,
    });
    const replayed = fx.store.replayDeadLetter(
      instance.id,
      { kind: "human", id: "operator-1" },
      {
        reason: "manual retry",
        grantId: "grant:replay:1",
        idempotencyKey: "replay-1",
      },
    );
    expect(replayed.state).toBe("pending");
    expect(replayed.input).toMatchObject({
      topic: "launch",
      replayAudit: {
        actor: { kind: "human", id: "operator-1" },
        reason: "manual retry",
        previousState: "dead_letter",
      },
    });
  });

  it.each([
    ["another subject", { subject: { kind: "human", id: "other-operator" } }],
    ["another workflow", { workflowId: "wf-other" }],
    ["another dead-letter instance", { instanceId: "instance-other" }],
    ["another resource kind", { resourceKind: "workflow" }],
    ["an inactive policy", { policyActive: false }],
  ])("rejects a replay grant bound to %s", (_label, grantOptions) => {
    const fx = workflowFixture();
    const published = publishWorkflow(fx, {
      id: "wf-1",
      name: "Launch workflow",
      ownerSubject: { kind: "human", id: "local" },
      definition: sampleDefinition(),
    });
    const instance = fx.store.createInstance({
      workflowId: "wf-1",
      workflowVersionId: published.workflowVersionId,
      triggerKind: "manual",
      runInput: { topic: "launch" },
    });
    fx.store.markDeadLetter(instance.id, "step failed");
    seedWorkflowReplayGrant(fx.forgeStore.db, "grant:replay:wrong", {
      instanceId: instance.id,
      ...grantOptions,
    });

    expect(() =>
      fx.store.replayDeadLetter(
        instance.id,
        { kind: "human", id: "operator-1" },
        {
          reason: "manual retry",
          grantId: "grant:replay:wrong",
          idempotencyKey: `replay-${_label}`,
        },
      ),
    ).toThrow(WorkflowReplayAuthorizationError);
    expect(fx.store.getInstance(instance.id).state).toBe("dead_letter");
  });
});

function workflowFixture(): { store: WorkflowStore; forgeStore: ForgeStore } {
  const root = mkdtempSync(join(tmpdir(), "forge-workflow-store-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const assets = new AssetRegistry(forgeStore.db);
  return { store: new WorkflowStore(forgeStore.db, assets), forgeStore };
}

function publishWorkflow(
  fx: { store: WorkflowStore; forgeStore: ForgeStore },
  draft: Parameters<WorkflowStore["publish"]>[0],
  gate = publishGate(draft.id ?? draft.definition.id),
) {
  return fx.store.publish(draft, (target) => {
    seedPublishEvidence(fx.forgeStore.db, {
      grantId: gate.permissionReviewId,
      validationIds: gate.validationIds,
      securityValidationId: gate.securityValidationId,
      assetId: target.assetId,
      assetVersionId: target.assetVersionId,
    });
    return gate;
  });
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

function publishGate(workflowId = "wf-1") {
  return {
    validationIds: [`validation-pass-${workflowId}`],
    permissionReviewId: `grant:publish:${workflowId}`,
    securityValidationId: `security-pass-${workflowId}`,
  };
}
