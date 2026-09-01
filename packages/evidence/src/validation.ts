import { randomUUID } from "node:crypto";
import type { Database } from "@forge/store";
import type { ValidationInput, ValidationResult, Validator } from "./types.js";

export class ValidatorRegistry {
  private readonly validators = new Map<string, Validator>();

  register(validator: Validator): void {
    this.validators.set(validator.id, validator);
  }

  list(): Validator[] {
    return [...this.validators.values()];
  }

  get(id: string): Validator | undefined {
    return this.validators.get(id);
  }
}

export class ValidationService {
  constructor(
    private readonly db: Database,
    private readonly registry: ValidatorRegistry,
  ) {}

  async validateDelivery(input: ValidationInput): Promise<{
    accepted: boolean;
    results: ValidationResult[];
  }> {
    const validators = this.registry.list();
    const results: ValidationResult[] = [];

    for (const validator of validators) {
      const result = await validator.validate(input);
      results.push(result);
      this.persistResult(input, validator.id, result);
    }

    const accepted = !results.some(
      (result) => result.status === "failed" && result.severity === "blocking",
    );

    return { accepted, results };
  }

  listByRun(runId: string): Array<{
    id: string;
    runId: string;
    deliveryId: string;
    validatorId: string;
    layer: ValidationResult["layer"];
    status: ValidationResult["status"];
    severity: ValidationResult["severity"];
    summary: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, delivery_id, validator_id, layer, status, severity,
                summary, created_at
         FROM core_validations
         WHERE run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(runId) as Array<{
      id: string;
      run_id: string;
      delivery_id: string;
      validator_id: string;
      layer: ValidationResult["layer"];
      status: ValidationResult["status"];
      severity: ValidationResult["severity"];
      summary: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      deliveryId: row.delivery_id,
      validatorId: row.validator_id,
      layer: row.layer,
      status: row.status,
      severity: row.severity,
      summary: row.summary,
      createdAt: row.created_at,
    }));
  }

  private persistResult(
    input: ValidationInput,
    validatorId: string,
    result: ValidationResult,
  ): void {
    this.db
      .prepare(
        `INSERT INTO core_validations (
          id, run_id, delivery_id, validator_id, layer, status, severity,
          evidence_ids_json, summary, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.runId,
        input.deliveryId,
        validatorId,
        result.layer,
        result.status,
        result.severity,
        JSON.stringify(result.evidenceIds),
        result.summary,
        JSON.stringify({}),
        new Date().toISOString(),
      );
  }
}

export function layerValidator(options: {
  id: string;
  layer: ValidationResult["layer"];
  status: ValidationResult["status"];
  severity?: ValidationResult["severity"];
  summary?: string;
  requiresEvidence?: boolean;
}): Validator {
  return {
    id: options.id,
    layer: options.layer,
    validate: async (input) => {
      if (options.requiresEvidence && input.evidenceIds.length === 0) {
        return {
          status: "inconclusive",
          layer: options.layer,
          severity: "warning",
          evidenceIds: [],
          summary: "missing supporting evidence",
        };
      }
      return {
        status: options.status,
        layer: options.layer,
        severity: options.severity ?? "blocking",
        evidenceIds: input.evidenceIds,
        summary: options.summary ?? `${options.layer} validation ${options.status}`,
      };
    },
  };
}
