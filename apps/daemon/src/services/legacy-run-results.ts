import { createHash } from "node:crypto";
import type { RunResult } from "@forge/protocol";
import type { Database } from "@forge/store";

export function persistLegacyRunResult(db: Database, result: RunResult): string {
  const digest = createHash("sha256")
    .update(result.sessionId)
    .update("\0")
    .update(result.finalText)
    .digest("hex");
  const outputRef = `forge-result:${digest}`;
  db.prepare(
    `INSERT OR IGNORE INTO core_legacy_run_results (
      output_ref, session_id, final_text, created_at
    ) VALUES (?, ?, ?, ?)`,
  ).run(outputRef, result.sessionId, result.finalText, new Date().toISOString());
  return outputRef;
}

export function readLegacyRunResult(
  db: Database,
  outputRef: string | null | undefined,
): RunResult | null {
  if (!outputRef) return null;
  const row = db
    .prepare(
      `SELECT session_id AS sessionId, final_text AS finalText
       FROM core_legacy_run_results
       WHERE output_ref = ?`,
    )
    .get(outputRef) as RunResult | undefined;
  return row ?? null;
}
