import type {
  ValidationInput,
  ValidationResult,
  Validator,
} from "../../types.js";

export class ResultValidator implements Validator {
  readonly id = "delivery-result";
  readonly layer = "result";

  async validate(input: ValidationInput): Promise<ValidationResult> {
    const failures = resultFailureReasons(input);
    return {
      status: failures.length === 0 ? "passed" : "failed",
      layer: this.layer,
      severity: failures.length === 0 ? "info" : "blocking",
      evidenceIds: input.evidenceIds,
      summary:
        failures.length === 0
          ? "delivery tests and checkpoint passed"
          : "delivery result checks failed",
      details: { failures },
    };
  }
}

export function resultFailureReasons(input: ValidationInput): string[] {
  const context = input.context ?? {};
  const failures: string[] = [];
  if (context.testsPassed !== true) failures.push("tests did not pass");
  if (context.buildPassed === false) failures.push("build did not pass");
  if (!nonEmptyString(context.checkpointId) && !nonEmptyString(context.checkpointHash)) {
    failures.push("checkpoint missing");
  }
  return failures;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
