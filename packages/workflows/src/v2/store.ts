import { randomUUID } from "node:crypto";
import type { Database } from "@forge/store";
import type { SubjectRef } from "@forge/protocol";
import {
  AssetRegistry,
} from "@forge/asset-registry";
import { hashWorkflowDefinition } from "./compiler.js";
import type {
  DurableWorkflowDefinition,
  PublishedWorkflowVersion,
  WorkflowDraftInput,
  WorkflowInstanceRecord,
  WorkflowQualityGateInput,
  WorkflowTriggerKind,
} from "./types.js";

export class WorkflowReplayAuthorizationError extends Error {
  constructor(message = "workflow replay is not authorized") {
    super(message);
    this.name = "WorkflowReplayAuthorizationError";
  }
}

export class WorkflowStore {
  static forDatabase(db: Database): WorkflowStore {
    return new WorkflowStore(db, new AssetRegistry(db));
  }

  constructor(
    private readonly db: Database,
    private readonly assets: AssetRegistry,
  ) {}

  publish(
    draft: WorkflowDraftInput,
    gate: WorkflowQualityGateInput,
  ): PublishedWorkflowVersion {
    const workflowId = draft.id ?? draft.definition.id;

    return this.db.transaction(() => {
      const nextVersion = this.nextWorkflowVersionNumber(workflowId);
      const definition = normalizeDefinition({
        ...draft.definition,
        id: workflowId,
        version: nextVersion,
      });
      const contentHash = hashWorkflowDefinition(definition);
      const versionContent = {
        description: draft.description ?? draft.name,
        definition,
      };

      const existingAsset = this.db
        .prepare(`SELECT id FROM core_assets WHERE id = ?`)
        .get(workflowId) as { id: string } | undefined;

      if (existingAsset) {
        this.assets.createVersionDraft(workflowId, {
          sourceRef: `workflow://${workflowId}`,
          contentHash,
          description: draft.description ?? draft.name,
          content: versionContent,
        });
      } else {
        this.assets.createDraft({
          id: workflowId,
          kind: "workflow",
          name: draft.name,
          ownerSubject: draft.ownerSubject,
          sourceRef: `workflow://${workflowId}`,
          contentHash,
          description: draft.description ?? draft.name,
          content: versionContent,
        });
      }

      const workflowVersionId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO core_workflow_versions (
          id, workflow_id, version, definition_json, input_schema_json,
          triggers_json, concurrency_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workflowVersionId,
          workflowId,
          nextVersion,
          JSON.stringify(definition),
          JSON.stringify(definition.inputSchema),
          JSON.stringify(definition.triggers),
          JSON.stringify(definition.concurrency),
          now,
        );

      const assetVersion = this.assets.publish(workflowId, {
        validationIds: gate.validationIds,
        permissionReviewId: gate.permissionReviewId,
        securityValidationId: gate.securityValidationId,
        description: gate.description ?? draft.description ?? draft.name,
      });

      this.db
        .prepare(
          `UPDATE core_workflow_versions
         SET asset_version_id = ?
         WHERE id = ?`,
        )
        .run(assetVersion.id, workflowVersionId);

      return {
        asset: this.assets.getAsset(workflowId),
        assetVersion,
        definition,
        workflowVersionId,
      };
    })();
  }

  getPublishedDefinition(workflowId: string): DurableWorkflowDefinition {
    const row = this.db
      .prepare(
        `SELECT wv.definition_json
         FROM core_workflow_versions wv
         INNER JOIN core_asset_versions av ON av.id = wv.asset_version_id
         WHERE wv.workflow_id = ?
           AND av.state = 'published'
         ORDER BY wv.version DESC
         LIMIT 1`,
      )
      .get(workflowId) as { definition_json: string } | undefined;
    if (!row) {
      throw new Error(`published workflow not found: ${workflowId}`);
    }
    return JSON.parse(row.definition_json) as DurableWorkflowDefinition;
  }

  getLatestPublishedVersion(workflowId: string): {
    workflowVersionId: string;
    definition: DurableWorkflowDefinition;
  } | null {
    const row = this.db
      .prepare(
        `SELECT wv.id, wv.definition_json
         FROM core_workflow_versions wv
         INNER JOIN core_asset_versions av ON av.id = wv.asset_version_id
         WHERE wv.workflow_id = ?
           AND av.state = 'published'
         ORDER BY wv.version DESC
         LIMIT 1`,
      )
      .get(workflowId) as { id: string; definition_json: string } | undefined;
    return row
      ? {
          workflowVersionId: row.id,
          definition: JSON.parse(row.definition_json) as DurableWorkflowDefinition,
        }
      : null;
  }

  createInstance(input: {
    workflowId: string;
    workflowVersionId: string;
    triggerKind: WorkflowTriggerKind;
    triggerRef?: string;
    concurrencyKey?: string;
    runInput: unknown;
    runId?: string;
  }): WorkflowInstanceRecord {
    return this.db.transaction(() => {
      this.assertPublishedWorkflowVersion(input.workflowId, input.workflowVersionId);
      if (!this.canStartInstanceInTransaction(input.workflowId, input.concurrencyKey)) {
        throw new Error("workflow concurrency limit reached");
      }

      const now = new Date().toISOString();
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO core_workflow_instances (
          id, workflow_id, workflow_version_id, run_id, state, trigger_kind,
          trigger_ref, concurrency_key, input_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.workflowId,
          input.workflowVersionId,
          input.runId ?? null,
          input.triggerKind,
          input.triggerRef ?? null,
          input.concurrencyKey ?? null,
          JSON.stringify(input.runInput),
          now,
          now,
        );

      return this.getInstance(id);
    })();
  }

  findInstanceByTriggerRef(
    workflowId: string,
    triggerRef: string,
  ): WorkflowInstanceRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, workflow_id, workflow_version_id, run_id, state, trigger_kind,
                trigger_ref, concurrency_key, input_json, created_at, updated_at
         FROM core_workflow_instances
         WHERE workflow_id = ? AND trigger_ref = ?`,
      )
      .get(workflowId, triggerRef) as InstanceRow | undefined;
    return row ? mapInstance(row) : null;
  }

  linkRun(instanceId: string, runId: string): WorkflowInstanceRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE core_workflow_instances
         SET run_id = ?, state = 'running', updated_at = ?
         WHERE id = ?`,
      )
      .run(runId, now, instanceId);
    return this.getInstance(instanceId);
  }

  updateInstanceState(
    instanceId: string,
    state: "running" | "waiting" | "succeeded" | "failed" | "cancelled",
  ): WorkflowInstanceRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE core_workflow_instances
         SET state = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(state, now, instanceId);
    return this.getInstance(instanceId);
  }

  countInstances(workflowId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM core_workflow_instances
           WHERE workflow_id = ?`,
        )
        .get(workflowId) as { count: number }
    ).count;
  }

  markDeadLetter(instanceId: string, reason: string): WorkflowInstanceRecord {
    const instance = this.getInstance(instanceId);
    const now = new Date().toISOString();
    const input =
      instance.input && typeof instance.input === "object" && !Array.isArray(instance.input)
        ? { ...(instance.input as Record<string, unknown>), deadLetterReason: reason }
        : { deadLetterReason: reason };
    this.db
      .prepare(
        `UPDATE core_workflow_instances
         SET state = 'dead_letter', updated_at = ?, input_json = ?
         WHERE id = ?`,
      )
      .run(now, JSON.stringify(input), instanceId);
    return this.getInstance(instanceId);
  }

  replayDeadLetter(
    instanceId: string,
    actor: SubjectRef,
    authorization: { reason: string; grantId: string; idempotencyKey: string },
  ): WorkflowInstanceRecord {
    if (!actor.kind?.trim() || !actor.id?.trim()) {
      throw new WorkflowReplayAuthorizationError("replay actor is required");
    }
    if (!authorization.reason.trim()) {
      throw new WorkflowReplayAuthorizationError("replay reason is required");
    }
    if (!authorization.grantId.trim()) {
      throw new WorkflowReplayAuthorizationError("replay grant is required");
    }
    if (!authorization.idempotencyKey.trim()) {
      throw new WorkflowReplayAuthorizationError("replay idempotency key is required");
    }

    const grant = this.db
      .prepare(
        `SELECT effect, expires_at, resource_scope_json FROM core_grants
         WHERE id = ? AND action = 'workflow.replay' AND effect = 'allow'`,
      )
      .get(authorization.grantId) as
      | { effect: string; expires_at: string | null; resource_scope_json: string }
      | undefined;
    if (!grant) {
      throw new WorkflowReplayAuthorizationError("replay grant is missing or denied");
    }
    if (grant.expires_at && grant.expires_at <= new Date().toISOString()) {
      throw new WorkflowReplayAuthorizationError("replay grant expired");
    }

    return this.db.transaction(() => {
      const instance = this.getInstance(instanceId);
      if (instance.state !== "dead_letter") {
        throw new Error(`workflow instance is not dead letter: ${instanceId}`);
      }

      const existingReplay = this.db
        .prepare(
          `SELECT replay_instance_id FROM core_workflow_dead_letter_replays
           WHERE dead_letter_instance_id = ?`,
        )
        .get(instanceId) as { replay_instance_id: string } | undefined;
      if (existingReplay) {
        throw new WorkflowReplayAuthorizationError(
          "dead letter already replayed successfully",
        );
      }

      const duplicateKey = this.db
        .prepare(
          `SELECT dead_letter_instance_id FROM core_workflow_dead_letter_replays
           WHERE idempotency_key = ?`,
        )
        .get(authorization.idempotencyKey) as
        | { dead_letter_instance_id: string }
        | undefined;
      if (duplicateKey) {
        throw new WorkflowReplayAuthorizationError("replay idempotency key already used");
      }

      if (!this.canStartInstanceInTransaction(instance.workflowId, instance.concurrencyKey)) {
        throw new Error("workflow concurrency limit reached");
      }

      const now = new Date().toISOString();
      const baseInput =
        instance.input && typeof instance.input === "object" && !Array.isArray(instance.input)
          ? (instance.input as Record<string, unknown>)
          : { value: instance.input };
      const { deadLetterReason: _ignored, ...rest } = baseInput;
      const input = {
        ...rest,
        replayAudit: {
          actor,
          reason: authorization.reason,
          grantId: authorization.grantId,
          idempotencyKey: authorization.idempotencyKey,
          replayedAt: now,
          previousState: "dead_letter",
          previousInstanceId: instanceId,
        },
      };

      this.db
        .prepare(
          `UPDATE core_workflow_instances
           SET state = 'pending', updated_at = ?, input_json = ?
           WHERE id = ?`,
        )
        .run(now, JSON.stringify(input), instanceId);

      this.db
        .prepare(
          `INSERT INTO core_workflow_dead_letter_replays (
            dead_letter_instance_id, replay_instance_id, grant_id,
            actor_kind, actor_id, reason, idempotency_key, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          instanceId,
          instanceId,
          authorization.grantId,
          actor.kind,
          actor.id,
          authorization.reason,
          authorization.idempotencyKey,
          now,
        );

      return this.getInstance(instanceId);
    })();
  }

  listDeadLetters(workflowId: string): WorkflowInstanceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, workflow_id, workflow_version_id, run_id, state, trigger_kind,
                trigger_ref, concurrency_key, input_json, created_at, updated_at
         FROM core_workflow_instances
         WHERE workflow_id = ? AND state = 'dead_letter'
         ORDER BY created_at DESC`,
      )
      .all(workflowId) as InstanceRow[];
    return rows.map(mapInstance);
  }

  canStartInstance(workflowId: string, concurrencyKey?: string): boolean {
    return this.canStartInstanceInTransaction(workflowId, concurrencyKey);
  }

  countActiveInstances(workflowId: string, concurrencyKey?: string): number {
    return this.countActiveInstancesInTransaction(workflowId, concurrencyKey);
  }

  private canStartInstanceInTransaction(
    workflowId: string,
    concurrencyKey?: string,
  ): boolean {
    const definition = this.getPublishedDefinition(workflowId);
    return (
      this.countActiveInstancesInTransaction(workflowId, concurrencyKey) <
      definition.concurrency.maxRuns
    );
  }

  private countActiveInstancesInTransaction(
    workflowId: string,
    concurrencyKey?: string,
  ): number {
    const activeStates = ["pending", "running", "waiting"];
    const placeholders = activeStates.map(() => "?").join(", ");
    const params: Array<string> = [workflowId, ...activeStates];
    let sql = `SELECT COUNT(*) AS count
               FROM core_workflow_instances
               WHERE workflow_id = ?
                 AND state IN (${placeholders})`;
    if (concurrencyKey) {
      sql += " AND concurrency_key = ?";
      params.push(concurrencyKey);
    }
    const row = this.db.prepare(sql).get(...params) as { count: number };
    return row.count;
  }

  private assertPublishedWorkflowVersion(
    workflowId: string,
    workflowVersionId: string,
  ): void {
    const row = this.db
      .prepare(
        `SELECT wv.id
         FROM core_workflow_versions wv
         INNER JOIN core_asset_versions av ON av.id = wv.asset_version_id
         WHERE wv.id = ?
           AND wv.workflow_id = ?
           AND av.state = 'published'`,
      )
      .get(workflowVersionId, workflowId) as { id: string } | undefined;
    if (!row) {
      throw new Error(
        `workflow version is not published: ${workflowId}/${workflowVersionId}`,
      );
    }
  }

  private nextWorkflowVersionNumber(workflowId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) AS maxVersion
         FROM core_workflow_versions
         WHERE workflow_id = ?`,
      )
      .get(workflowId) as { maxVersion: number };
    return row.maxVersion + 1;
  }

  private getInstance(id: string): WorkflowInstanceRecord {
    const row = this.db
      .prepare(
        `SELECT id, workflow_id, workflow_version_id, run_id, state, trigger_kind,
                trigger_ref, concurrency_key, input_json, created_at, updated_at
         FROM core_workflow_instances
         WHERE id = ?`,
      )
      .get(id) as InstanceRow | undefined;
    if (!row) {
      throw new Error(`workflow instance not found: ${id}`);
    }
    return mapInstance(row);
  }
}

function normalizeDefinition(
  definition: DurableWorkflowDefinition,
): DurableWorkflowDefinition {
  return {
    ...definition,
    version: definition.version ?? 1,
    triggers: definition.triggers ?? [{ kind: "manual" }],
    concurrency: definition.concurrency ?? { maxRuns: 1 },
  };
}

interface InstanceRow {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  run_id: string | null;
  state: string;
  trigger_kind: WorkflowTriggerKind;
  trigger_ref: string | null;
  concurrency_key: string | null;
  input_json: string;
  created_at: string;
  updated_at: string;
}

function mapInstance(row: InstanceRow): WorkflowInstanceRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    runId: row.run_id ?? undefined,
    state: row.state,
    triggerKind: row.trigger_kind,
    triggerRef: row.trigger_ref ?? undefined,
    concurrencyKey: row.concurrency_key ?? undefined,
    input: JSON.parse(row.input_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
