import { randomUUID } from "node:crypto";
import type { Database } from "@forge/store";
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
    const definition = normalizeDefinition(draft.definition);
    const workflowId = draft.id ?? definition.id;
    const contentHash = hashWorkflowDefinition(definition);
    const asset = this.assets.createDraft({
      id: workflowId,
      kind: "workflow",
      name: draft.name,
      ownerSubject: draft.ownerSubject,
      sourceRef: `workflow://${definition.id}`,
      contentHash,
      description: draft.description ?? draft.name,
      content: { description: draft.description ?? draft.name },
    });

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
        definition.id,
        definition.version,
        JSON.stringify(definition),
        JSON.stringify(definition.inputSchema),
        JSON.stringify(definition.triggers),
        JSON.stringify(definition.concurrency),
        now,
      );

    const assetVersion = this.assets.publish(asset.id, {
      validationIds: gate.validationIds,
      permissionReviewed: gate.permissionReviewed,
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
      asset: this.assets.getAsset(asset.id),
      assetVersion,
      definition,
      workflowVersionId,
    };
  }

  getPublishedDefinition(workflowId: string): DurableWorkflowDefinition {
    const row = this.db
      .prepare(
        `SELECT definition_json
         FROM core_workflow_versions
         WHERE workflow_id = ?
         ORDER BY version DESC
         LIMIT 1`,
      )
      .get(workflowId) as { definition_json: string } | undefined;
    if (!row) {
      throw new Error(`workflow not found: ${workflowId}`);
    }
    return JSON.parse(row.definition_json) as DurableWorkflowDefinition;
  }

  getLatestPublishedVersion(workflowId: string): {
    workflowVersionId: string;
    definition: DurableWorkflowDefinition;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, definition_json
         FROM core_workflow_versions
         WHERE workflow_id = ?
         ORDER BY version DESC
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
    if (!this.canStartInstance(input.workflowId, input.concurrencyKey)) {
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
    const definition = this.getPublishedDefinition(workflowId);
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
    return row.count < definition.concurrency.maxRuns;
  }

  countActiveInstances(workflowId: string, concurrencyKey?: string): number {
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
