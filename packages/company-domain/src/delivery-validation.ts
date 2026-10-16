export const COMPANY_DELIVERY_LAYERS = ["result", "process", "answer"] as const;

export type DeliveryLayer = (typeof COMPANY_DELIVERY_LAYERS)[number];

export function hasPassedDeliveryLayers(
  validations: Array<{ layer?: string; status: string }>,
): boolean {
  return COMPANY_DELIVERY_LAYERS.every((layer) =>
    validations.some((row) => row.layer === layer && row.status === "passed"),
  );
}

export function recordCompanyValidation(
  db: {
    prepare(sql: string): {
      get(...args: unknown[]): unknown;
      run(...args: unknown[]): unknown;
    };
  },
  input: {
    id: string;
    runId: string;
    validatorId: string;
    layer: DeliveryLayer;
    status: "passed" | "failed" | "inconclusive";
    summary: string;
    createdAt: string;
    severity?: "info" | "warning" | "blocking";
  },
): void {
  const existing = db
    .prepare(
      `SELECT id FROM core_validations
      WHERE run_id = ? AND validator_id = ?
      LIMIT 1`,
    )
    .get(input.runId, input.validatorId) as { id: string } | undefined;
  if (existing) return;
  db.prepare(
    `INSERT INTO core_validations (
      id, run_id, validator_id, layer, status, severity,
      evidence_ids_json, summary, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.validatorId,
    input.layer,
    input.status,
    input.severity ?? (input.status === "failed" ? "blocking" : "info"),
    "[]",
    input.summary,
    "{}",
    input.createdAt,
  );
}
