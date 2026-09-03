import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  AutomationDraft,
  AutomationNotifyConfig,
  AutomationRecord,
  AutomationRunRecord,
  AutomationRunStatus,
  AutomationRunTrigger,
  ChannelKind,
} from "@forge/protocol";
import { computeNextRun } from "./cron.js";

export interface CreateAutomationInput {
  name: string;
  description?: string;
  cwd: string;
  trigger: AutomationRecord["trigger"];
  prompt: string;
  model?: string;
  memoryEnabled?: boolean;
  sessionMode?: "new" | "resume";
  resumeSessionId?: string;
  notify?: AutomationNotifyConfig;
  enabled?: boolean;
}

export type UpdateAutomationPatch = Partial<CreateAutomationInput> & {
  enabled?: boolean;
};

export interface InsertRunInput {
  automationId: string;
  sessionId: string;
  status: AutomationRunStatus;
  trigger: AutomationRunTrigger;
  error?: string;
  preview?: string;
  triggerRef?: string;
}

export interface UpdateRunPatch {
  status?: AutomationRunStatus;
  sessionId?: string;
  finishedAt?: string | null;
  error?: string | null;
  preview?: string;
  workflowInstanceId?: string;
  durableRunId?: string;
  triggerRef?: string;
}

export interface FinishRunPatch {
  status: AutomationRunStatus;
  error?: string;
  preview?: string;
}

interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  cwd: string;
  trigger_type: string;
  cron_expr: string | null;
  timezone: string | null;
  prompt: string;
  model: string | null;
  memory_enabled: number;
  session_mode: string;
  resume_session_id: string | null;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  notify_enabled?: number | null;
  notify_channel_kind?: string | null;
  notify_channel_id?: string | null;
  notify_thread_key?: string | null;
}

interface AutomationRunRow {
  id: string;
  automation_id: string;
  session_id: string;
  status: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  preview: string | null;
  workflow_instance_id?: string | null;
  durable_run_id?: string | null;
  trigger_ref?: string | null;
}

function rowToRecord(row: AutomationRow): AutomationRecord {
  const trigger: AutomationRecord["trigger"] =
    row.trigger_type === "cron" && row.cron_expr && row.timezone
      ? { type: "cron", cron: row.cron_expr, timezone: row.timezone }
      : { type: "manual" };
  const notifyChannelKind =
    row.notify_channel_kind === "ilink" ||
    row.notify_channel_kind === "feishu" ||
    row.notify_channel_kind === "dingtalk" ||
    row.notify_channel_kind === "http"
      ? (row.notify_channel_kind as ChannelKind)
      : undefined;

  const notify: AutomationNotifyConfig = {
    enabled: row.notify_enabled === 1,
    channelKind: notifyChannelKind,
    channelId: row.notify_channel_id ?? undefined,
    threadKey: row.notify_thread_key ?? undefined,
  };

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled === 1,
    cwd: row.cwd,
    trigger,
    prompt: row.prompt,
    model: row.model ?? undefined,
    memoryEnabled: row.memory_enabled === 1,
    sessionMode: row.session_mode as "new" | "resume",
    resumeSessionId: row.resume_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    notify,
  };
}

function rowToRun(row: AutomationRunRow): AutomationRunRecord {
  return {
    id: row.id,
    automationId: row.automation_id,
    sessionId: row.session_id,
    status: row.status as AutomationRunStatus,
    trigger: row.trigger as AutomationRunTrigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
    preview: row.preview ?? undefined,
    workflowInstanceId: row.workflow_instance_id ?? undefined,
    durableRunId: row.durable_run_id ?? undefined,
    triggerRef: row.trigger_ref ?? undefined,
  };
}

function draftToInput(draft: AutomationDraft & { cwd: string }): CreateAutomationInput {
  const trigger: AutomationRecord["trigger"] = draft.cron
    ? {
        type: "cron",
        cron: draft.cron,
        timezone: draft.timezone ?? "UTC",
      }
    : { type: "manual" };

  return {
    name: draft.name,
    description: draft.description,
    cwd: draft.cwd,
    trigger,
    prompt: draft.prompt,
    enabled: draft.enabled,
    notify: draft.notify,
  };
}

export class AutomationStore {
  constructor(private readonly db: Database.Database) {
    this.ensureNotifyColumns();
    this.ensureDurableRunColumns();
  }

  private ensureNotifyColumns(): void {
    const rows = this.db.prepare("PRAGMA table_info(automations)").all() as Array<{
      name: string;
    }>;
    const names = new Set(rows.map((r) => r.name));
    if (!names.has("notify_enabled")) {
      this.db.exec(
        "ALTER TABLE automations ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!names.has("notify_channel_kind")) {
      this.db.exec("ALTER TABLE automations ADD COLUMN notify_channel_kind TEXT");
    }
    if (!names.has("notify_channel_id")) {
      this.db.exec("ALTER TABLE automations ADD COLUMN notify_channel_id TEXT");
    }
    if (!names.has("notify_thread_key")) {
      this.db.exec("ALTER TABLE automations ADD COLUMN notify_thread_key TEXT");
    }
  }

  private ensureDurableRunColumns(): void {
    const rows = this.db.prepare("PRAGMA table_info(automation_runs)").all() as Array<{
      name: string;
    }>;
    const names = new Set(rows.map((row) => row.name));
    if (!names.has("workflow_instance_id")) {
      this.db.exec("ALTER TABLE automation_runs ADD COLUMN workflow_instance_id TEXT");
    }
    if (!names.has("durable_run_id")) {
      this.db.exec("ALTER TABLE automation_runs ADD COLUMN durable_run_id TEXT");
    }
    if (!names.has("trigger_ref")) {
      this.db.exec("ALTER TABLE automation_runs ADD COLUMN trigger_ref TEXT");
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_run_occurrence
        ON automation_runs(automation_id, trigger_ref)
        WHERE trigger_ref IS NOT NULL
    `);
  }

  create(input: CreateAutomationInput | (AutomationDraft & { cwd: string })): AutomationRecord {
    const data =
      "trigger" in input ? input : draftToInput(input as AutomationDraft & { cwd: string });
    const id = randomUUID();
    const now = new Date().toISOString();
    const enabled = data.enabled ?? false;
    const triggerType = data.trigger.type;
    const cronExpr = data.trigger.type === "cron" ? data.trigger.cron : null;
    const timezone = data.trigger.type === "cron" ? data.trigger.timezone : null;
    const nextRunAt =
      enabled && data.trigger.type === "cron"
        ? computeNextRun(data.trigger.cron, data.trigger.timezone)
        : null;

    this.db
      .prepare(
        `INSERT INTO automations (
          id, name, description, enabled, cwd, trigger_type, cron_expr, timezone,
          prompt, model, memory_enabled, session_mode, resume_session_id,
          created_at, updated_at, last_run_at, next_run_at,
          notify_enabled, notify_channel_kind, notify_channel_id, notify_thread_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.name,
        data.description ?? null,
        enabled ? 1 : 0,
        data.cwd,
        triggerType,
        cronExpr,
        timezone,
        data.prompt,
        data.model ?? null,
        data.memoryEnabled ? 1 : 0,
        data.sessionMode ?? "new",
        data.resumeSessionId ?? null,
        now,
        now,
        null,
        nextRunAt,
        data.notify?.enabled ? 1 : 0,
        data.notify?.channelKind ?? null,
        data.notify?.channelId ?? null,
        data.notify?.threadKey ?? null,
      );

    return this.get(id)!;
  }

  get(id: string): AutomationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM automations WHERE id = ?")
      .get(id) as AutomationRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(opts?: { cwd?: string }): AutomationRecord[] {
    const rows = opts?.cwd
      ? (this.db
          .prepare("SELECT * FROM automations WHERE cwd = ? ORDER BY updated_at DESC")
          .all(opts.cwd) as AutomationRow[])
      : (this.db
          .prepare("SELECT * FROM automations ORDER BY updated_at DESC")
          .all() as AutomationRow[]);
    return rows.map(rowToRecord);
  }

  update(id: string, patch: UpdateAutomationPatch): AutomationRecord | null {
    const existing = this.get(id);
    if (!existing) return null;

    const name = patch.name ?? existing.name;
    const description =
      patch.description !== undefined ? patch.description : existing.description;
    const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
    const cwd = patch.cwd ?? existing.cwd;
    const trigger = patch.trigger ?? existing.trigger;
    const prompt = patch.prompt ?? existing.prompt;
    const model = patch.model !== undefined ? patch.model : existing.model;
    const memoryEnabled =
      patch.memoryEnabled !== undefined ? patch.memoryEnabled : existing.memoryEnabled;
    const sessionMode = patch.sessionMode ?? existing.sessionMode;
    const resumeSessionId =
      patch.resumeSessionId !== undefined
        ? patch.resumeSessionId
        : existing.resumeSessionId;
    const notify = patch.notify !== undefined ? patch.notify : existing.notify;
    const now = new Date().toISOString();

    let nextRunAt = existing.nextRunAt ?? null;
    if (trigger.type === "cron") {
      if (enabled) {
        nextRunAt = computeNextRun(trigger.cron, trigger.timezone);
      } else {
        nextRunAt = null;
      }
    } else {
      nextRunAt = null;
    }

    this.db
      .prepare(
        `UPDATE automations SET
          name = ?, description = ?, enabled = ?, cwd = ?, trigger_type = ?,
          cron_expr = ?, timezone = ?, prompt = ?, model = ?, memory_enabled = ?,
          session_mode = ?, resume_session_id = ?, updated_at = ?, next_run_at = ?,
          notify_enabled = ?, notify_channel_kind = ?, notify_channel_id = ?,
          notify_thread_key = ?
        WHERE id = ?`,
      )
      .run(
        name,
        description ?? null,
        enabled ? 1 : 0,
        cwd,
        trigger.type,
        trigger.type === "cron" ? trigger.cron : null,
        trigger.type === "cron" ? trigger.timezone : null,
        prompt,
        model ?? null,
        memoryEnabled ? 1 : 0,
        sessionMode,
        resumeSessionId ?? null,
        now,
        nextRunAt,
        notify?.enabled ? 1 : 0,
        notify?.channelKind ?? null,
        notify?.channelId ?? null,
        notify?.threadKey ?? null,
        id,
      );

    return this.get(id);
  }

  delete(id: string): boolean {
    this.db.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(id);
    const result = this.db.prepare("DELETE FROM automations WHERE id = ?").run(id);
    return result.changes > 0;
  }

  insertRun(input: InsertRunInput): AutomationRunRecord {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const finishedAt =
      input.status === "skipped" || input.status === "success" || input.status === "failed"
        ? startedAt
        : null;

    this.db
      .prepare(
        `INSERT INTO automation_runs (
          id, automation_id, session_id, status, trigger, started_at, finished_at, error, preview,
          trigger_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.automationId,
        input.sessionId,
        input.status,
        input.trigger,
        startedAt,
        finishedAt,
        input.error ?? null,
        input.preview ?? null,
        input.triggerRef ?? null,
      );

    return this.listRuns(input.automationId, 1)[0]!;
  }

  getRunByTriggerRef(
    automationId: string,
    triggerRef: string,
  ): AutomationRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM automation_runs
         WHERE automation_id = ? AND trigger_ref = ?`,
      )
      .get(automationId, triggerRef) as AutomationRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  updateRun(id: string, patch: UpdateRunPatch): AutomationRunRecord | null {
    const existing = this.db
      .prepare("SELECT * FROM automation_runs WHERE id = ?")
      .get(id) as AutomationRunRow | undefined;
    if (!existing) return null;

    const status = patch.status ?? (existing.status as AutomationRunStatus);
    const sessionId = patch.sessionId ?? existing.session_id;
    const finishedAt =
      patch.finishedAt !== undefined
        ? patch.finishedAt
        : existing.finished_at;
    const error = patch.error !== undefined ? patch.error : existing.error;
    const preview = patch.preview !== undefined ? patch.preview : existing.preview;
    const workflowInstanceId =
      patch.workflowInstanceId !== undefined
        ? patch.workflowInstanceId
        : existing.workflow_instance_id;
    const durableRunId =
      patch.durableRunId !== undefined ? patch.durableRunId : existing.durable_run_id;

    this.db
      .prepare(
        `UPDATE automation_runs SET
          status = ?, session_id = ?, finished_at = ?, error = ?, preview = ?,
          workflow_instance_id = ?, durable_run_id = ?
        WHERE id = ?`,
      )
      .run(
        status,
        sessionId,
        finishedAt,
        error,
        preview,
        workflowInstanceId,
        durableRunId,
        id,
      );

    const row = this.db
      .prepare("SELECT * FROM automation_runs WHERE id = ?")
      .get(id) as AutomationRunRow;
    return rowToRun(row);
  }

  finishRun(id: string, patch: FinishRunPatch): AutomationRunRecord | null {
    return this.updateRun(id, {
      ...patch,
      finishedAt: new Date().toISOString(),
    });
  }

  listRuns(automationId: string, limit = 20): AutomationRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM automation_runs
         WHERE automation_id = ?
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(automationId, limit) as AutomationRunRow[];
    return rows.map(rowToRun);
  }

  listRunningDurableRuns(): AutomationRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM automation_runs
         WHERE status = 'running'
           AND workflow_instance_id IS NOT NULL
           AND durable_run_id IS NOT NULL
         ORDER BY started_at`,
      )
      .all() as AutomationRunRow[];
    return rows.map(rowToRun);
  }

  hasRunningRun(automationId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM automation_runs
         WHERE automation_id = ? AND status = 'running'
         LIMIT 1`,
      )
      .get(automationId);
    return row !== undefined;
  }

  listEnabledCron(): AutomationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM automations
         WHERE enabled = 1 AND trigger_type = 'cron'
         ORDER BY next_run_at ASC`,
      )
      .all() as AutomationRow[];
    return rows.map(rowToRecord);
  }

  setNextRunAt(id: string, iso: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE automations SET next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(iso, now, id);
  }

  touchLastRun(id: string, iso = new Date().toISOString()): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE automations SET last_run_at = ?, updated_at = ? WHERE id = ?")
      .run(iso, now, id);
  }
}
