import { persistResearchResult } from "./research-result.js";
import type { DeliveryTrace } from "@forge/protocol";
import type Database from "better-sqlite3";
import { isAbsolute, relative, resolve } from "node:path";
import { hasPassedDeliveryLayers } from "./delivery-validation.js";

export interface WorkspaceFilePreview {
  path: string;
  runId: string;
  previewable: boolean;
  content?: string;
  mediaType?: string;
  reason?: string;
}

export function buildDeliveryTrace(
  db: Database.Database,
  workItemId: string,
): DeliveryTrace {
  const accepted = db
    .prepare(
      `SELECT
        MAX(CASE WHEN kind = 'spec' AND status = 'accepted' THEN version END)
          AS specVersion,
        MAX(CASE WHEN kind = 'plan' AND status = 'accepted' THEN version END)
          AS planVersion
      FROM company_work_artifacts
      WHERE work_item_id = ?`,
    )
    .get(workItemId) as {
    specVersion: number | null;
    planVersion: number | null;
  };
  const linkedRuns = db
    .prepare(
      `SELECT
        link.run_id AS runId,
        link.created_at AS createdAt,
        run.state AS state
      FROM company_run_links AS link
      LEFT JOIN core_runs AS run ON run.id = link.run_id
      WHERE link.work_item_id = ? AND TRIM(link.run_id) <> ''
      ORDER BY link.created_at, link.id`,
    )
    .all(workItemId) as Array<{
    runId: string;
    createdAt: string;
    state: string | null;
  }>;
  const runs = attachRunSessions(
    db,
    linkedRuns.map((run) => ({
      runId: run.runId,
      createdAt: run.createdAt,
      ...(run.state ? { state: run.state } : {}),
    })),
  );
  const linkedRunIds = runs.map(({ runId }) => runId);
  const validationRows =
    linkedRunIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT id, run_id AS runId, status, summary, validator_id AS validatorId,
              layer
            FROM core_validations
            WHERE run_id IN (${linkedRunIds.map(() => "?").join(", ")})
            ORDER BY created_at, id`,
          )
          .all(...linkedRunIds) as Array<{
          id: string;
          runId: string;
          status: "passed" | "failed" | "inconclusive";
          summary: string;
          validatorId: string;
          layer: "result" | "process" | "answer";
        }>);
  const evidence =
    linkedRunIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT id, run_id AS runId, claim,
              source_kind AS sourceKind, source_ref AS sourceRef
            FROM core_evidence
            WHERE run_id IN (${linkedRunIds.map(() => "?").join(", ")})
            ORDER BY created_at, id`,
          )
          .all(...linkedRunIds) as Array<{
          id: string;
          runId: string;
          claim: string;
          sourceKind: string;
          sourceRef: string;
        }>);
  const outputs =
    linkedRunIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT id, producer_run_id AS runId, media_type AS mediaType,
              content_ref AS contentRef
            FROM core_artifacts
            WHERE producer_run_id IN (${linkedRunIds.map(() => "?").join(", ")})
            ORDER BY created_at, id`,
          )
          .all(...linkedRunIds) as Array<{
          id: string;
          runId: string;
          mediaType: string;
          contentRef: string;
        }>);
  const artifactIds = db
    .prepare(
      `SELECT id
      FROM company_work_artifacts
      WHERE work_item_id = ? AND kind IN ('intent', 'spec', 'plan')
      ORDER BY created_at, id`,
    )
    .all(workItemId) as Array<{ id: string }>;

  return {
    workItemId,
    ...(accepted.specVersion === null
      ? {}
      : { specVersion: accepted.specVersion }),
    ...(accepted.planVersion === null
      ? {}
      : { planVersion: accepted.planVersion }),
    runIds: linkedRunIds,
    runs,
    artifactIds: artifactIds.map(({ id }) => id),
    validationIds: validationRows.map(({ id }) => id),
    validations: validationRows,
    evidence,
    outputs: [...outputs, ...readRunOutputs(db, linkedRunIds, outputs)],
    workspaceFiles: readWorkspaceFiles(db, linkedRunIds),
  };
}

// An agent's final report is saved with the attempt, separately from file artifacts.
// Join by the immutable output reference, never by the session's latest message.
function readRunOutputs(
  db: Database.Database,
  runIds: string[],
  files: DeliveryTrace["outputs"],
): DeliveryTrace["outputs"] {
  if (!runIds.length) return [];
  const rows = db.prepare(`SELECT attempt.id, attempt.run_id AS runId,
      attempt.output_ref AS contentRef, result.final_text AS content,
      result.session_id AS sessionId,
      COALESCE(attempt.finished_at, attempt.updated_at) AS createdAt
    FROM core_attempts AS attempt
    LEFT JOIN core_legacy_run_results AS result ON result.output_ref = attempt.output_ref
    WHERE attempt.run_id IN (${runIds.map(() => "?").join(",")})
      AND attempt.state = 'succeeded' AND TRIM(COALESCE(attempt.output_ref, '')) <> ''
    ORDER BY attempt.created_at, attempt.attempt_number, attempt.id`).all(...runIds) as Array<{
      id: string; runId: string; contentRef: string; content: string | null;
      sessionId: string | null; createdAt: string;
    }>;
  const seen = new Set(files.map((file) => `${file.runId}:${file.contentRef}`));
  return rows.flatMap((row) => {
    const key = `${row.runId}:${row.contentRef}`;
    if (seen.has(key) || files.some((file) => file.runId === row.runId &&
      (row.contentRef === file.id || row.contentRef === `artifact:${file.id}`))) return [];
    seen.add(key);
    const researchResult = row.content === null ? null : persistResearchResult(db, row.content, row.runId, row.contentRef);
    return [{
      id: row.id, runId: row.runId, mediaType: "text/markdown", contentRef: row.contentRef,
      kind: "report" as const, createdAt: row.createdAt,
      ...(researchResult ? { researchResult } : {}),
      ...(row.content !== null ? { content: row.content } : {}),
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    }];
  });
}

const WRITE_TOOL_NAMES = new Set(["write_file", "write_patch"]);
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isSafeWorkspacePath(path: string): boolean {
  const trimmed = normalizeWorkspacePath(path);
  if (!trimmed || trimmed === "." || trimmed === "/") return false;
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return false;
  const parts = trimmed.split("/");
  return parts.length > 0 && !parts.some((part) => part === ".." || part === "." || part === "");
}

export function previewWorkspaceFile(
  db: Database.Database,
  workItemId: string,
  requestedPath: string,
  options?: { readFile?: (cwd: string, relativePath: string) => string | null },
): WorkspaceFilePreview {
  const path = normalizeWorkspacePath(requestedPath);
  if (!isSafeWorkspacePath(path)) throw new Error("workspace file not found");
  const trace = buildDeliveryTrace(db, workItemId);
  const file = trace.workspaceFiles.find((entry) => entry.path === path);
  if (!file) throw new Error("workspace file not found");
  const run = trace.runs.find((row) => row.runId === file.runId);
  let content: string | null = null;
  if (run?.cwd && options?.readFile) {
    const absolute = resolveUnderCwd(run.cwd, file.path);
    if (absolute) content = options.readFile(run.cwd, file.path);
  }
  if (content == null) content = readWriteFileContent(db, file.runId, file.path);
  if (content == null) {
    return {
      path: file.path,
      runId: file.runId,
      previewable: false,
      reason: "没有可预览正文，请在工作台查看。",
    };
  }
  if (Buffer.byteLength(content, "utf8") > TEXT_PREVIEW_LIMIT) {
    return {
      path: file.path,
      runId: file.runId,
      previewable: false,
      reason: "文件超过 2 MB，请在工作台查看。",
    };
  }
  return {
    path: file.path,
    runId: file.runId,
    previewable: true,
    content,
    mediaType: mediaTypeForPath(file.path),
  };
}

function resolveUnderCwd(cwd: string, relativePath: string): string | null {
  if (!cwd.trim() || !isSafeWorkspacePath(relativePath)) return null;
  const root = resolve(cwd);
  const absolute = resolve(root, relativePath);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return absolute;
}

function readWriteFileContent(
  db: Database.Database,
  runId: string,
  path: string,
): string | null {
  const row = db
    .prepare(
      `SELECT json_extract(envelope_json, '$.data.args.content') AS content
      FROM core_events
      WHERE run_id = ?
        AND json_extract(envelope_json, '$.data.type') = 'tool_start'
        AND json_extract(envelope_json, '$.data.name') = 'write_file'
        AND json_extract(envelope_json, '$.data.args.path') = ?
        AND json_extract(envelope_json, '$.data.args.content') IS NOT NULL
      ORDER BY sequence DESC, event_id DESC
      LIMIT 1`,
    )
    .get(runId, path) as { content: string | null } | undefined;
  return typeof row?.content === "string" ? row.content : null;
}

function mediaTypeForPath(path: string): string {
  if (/\.(md|markdown)$/i.test(path)) return "text/markdown";
  if (/\.json$/i.test(path)) return "application/json";
  return "text/plain";
}

// Paths the agent wrote in the workbench workspace. Names only — never file bodies.
function readWorkspaceFiles(
  db: Database.Database,
  runIds: string[],
): DeliveryTrace["workspaceFiles"] {
  if (!runIds.length) return [];
  const rows = db
    .prepare(
      `SELECT run_id AS runId,
        json_extract(envelope_json, '$.data.name') AS tool,
        json_extract(envelope_json, '$.data.args.path') AS path
      FROM core_events
      WHERE run_id IN (${runIds.map(() => "?").join(", ")})
        AND json_extract(envelope_json, '$.data.type') = 'tool_start'
        AND TRIM(COALESCE(json_extract(envelope_json, '$.data.args.path'), '')) <> ''
      ORDER BY sequence, event_id`,
    )
    .all(...runIds) as Array<{ runId: string; tool: string | null; path: string | null }>;
  const seen = new Set<string>();
  const files: DeliveryTrace["workspaceFiles"] = [];
  for (const row of rows) {
    const path = String(row.path || "").trim();
    const tool = String(row.tool || "");
    if (!WRITE_TOOL_NAMES.has(tool) || !isSafeWorkspacePath(path) || seen.has(path)) {
      continue;
    }
    seen.add(path);
    files.push({ path, runId: row.runId });
    if (files.length >= 40) break;
  }
  return files;
}

function attachRunSessions(
  db: Database.Database,
  runs: DeliveryTrace["runs"],
): DeliveryTrace["runs"] {
  if (runs.length === 0) return runs;
  const runIds = runs.map(({ runId }) => runId);
  const placeholders = runIds.map(() => "?").join(", ");
  const specRows = db
    .prepare(
      `SELECT
        id AS runId,
        json_extract(spec_json, '$.steps[0].input.sessionId') AS sessionId,
        json_extract(spec_json, '$.steps[0].input.cwd') AS cwd
      FROM core_runs
      WHERE id IN (${placeholders})`,
    )
    .all(...runIds) as Array<{
    runId: string;
    sessionId: string | null;
    cwd: string | null;
  }>;
  const sessionFromEvent = db.prepare(
    `SELECT json_extract(envelope_json, '$.data.sessionId') AS sessionId
     FROM core_events
     WHERE run_id = ?
       AND json_extract(envelope_json, '$.data.sessionId') IS NOT NULL
       AND TRIM(json_extract(envelope_json, '$.data.sessionId')) <> ''
     LIMIT 1`,
  );
  const cwdFromSession = db.prepare("SELECT cwd FROM sessions WHERE id = ?");
  const byRun = new Map<string, { sessionId?: string; cwd?: string }>();
  for (const row of specRows) {
    byRun.set(row.runId, {
      ...(typeof row.sessionId === "string" && row.sessionId
        ? { sessionId: row.sessionId }
        : {}),
      ...(typeof row.cwd === "string" && row.cwd ? { cwd: row.cwd } : {}),
    });
  }
  for (const runId of runIds) {
    const prev = byRun.get(runId) ?? {};
    if (!prev.sessionId) {
      const event = sessionFromEvent.get(runId) as { sessionId?: string } | undefined;
      if (typeof event?.sessionId === "string" && event.sessionId) {
        prev.sessionId = event.sessionId;
      }
    }
    if (prev.sessionId && !prev.cwd) {
      const session = cwdFromSession.get(prev.sessionId) as { cwd?: string } | undefined;
      if (typeof session?.cwd === "string" && session.cwd) {
        prev.cwd = session.cwd;
      }
    }
    if (prev.sessionId || prev.cwd) byRun.set(runId, prev);
  }
  return runs.map((run) => {
    const extra = byRun.get(run.runId);
    return {
      ...run,
      ...(extra?.sessionId ? { sessionId: extra.sessionId } : {}),
      ...(extra?.cwd ? { cwd: extra.cwd } : {}),
    };
  });
}

export function canMarkDelivered(trace: DeliveryTrace): boolean {
  return (
    trace.specVersion != null &&
    trace.planVersion != null &&
    trace.runIds.length > 0 &&
    hasPassedDeliveryLayers(trace.validations)
  );
}
