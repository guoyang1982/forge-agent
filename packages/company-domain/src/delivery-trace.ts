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
    runIds: runIds.map(({ runId }) => runId),
    artifactIds: artifactIds.map(({ id }) => id),
    validationIds: [],
  };
}

export function canMarkDelivered(trace: DeliveryTrace): boolean {
  return (
    trace.specVersion != null &&
    trace.planVersion != null &&
    trace.runIds.length > 0
  );
}
