import type { DeliveryTrace } from "@forge/protocol";
import type Database from "better-sqlite3";

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
  const runIds = db
    .prepare(
      `SELECT run_id AS runId
      FROM company_run_links
      WHERE work_item_id = ? AND TRIM(run_id) <> ''
      ORDER BY created_at, id`,
    )
    .all(workItemId) as Array<{ runId: string }>;
  const linkedRunIds = runIds.map(({ runId }) => runId);
  const validationIds =
    linkedRunIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT id
            FROM core_validations
            WHERE run_id IN (${linkedRunIds.map(() => "?").join(", ")})
            ORDER BY created_at, id`,
          )
          .all(...linkedRunIds) as Array<{ id: string }>);
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
    artifactIds: artifactIds.map(({ id }) => id),
    validationIds: validationIds.map(({ id }) => id),
  };
}

export function canMarkDelivered(trace: DeliveryTrace): boolean {
  return (
    trace.specVersion != null &&
    trace.planVersion != null &&
    trace.runIds.length > 0
  );
}
