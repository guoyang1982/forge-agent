import type {
  ValidationInput,
  ValidationResult,
  Validator,
} from "../../types.js";
import { processFailureReasons } from "./process-validator.js";
import { resultFailureReasons } from "./result-validator.js";

export class AnswerValidator implements Validator {
  readonly id = "delivery-answer";
  readonly layer = "answer";

  async validate(input: ValidationInput): Promise<ValidationResult> {
    const claim = readClaim(input);
    const underlyingFailures = [
      ...resultFailureReasons(input),
      ...processFailureReasons(input),
    ];
    const falseSuccessClaim =
      assertsSuccess(claim) && underlyingFailures.length > 0;
    return {
      status: falseSuccessClaim ? "failed" : "passed",
      layer: this.layer,
      severity: falseSuccessClaim ? "blocking" : "info",
      evidenceIds: input.evidenceIds,
      summary: falseSuccessClaim
        ? "final answer claims success despite failed delivery checks"
        : "final answer is consistent with delivery checks",
      details: {
        claim,
        underlyingFailures,
      },
    };
  }
}

function readClaim(input: ValidationInput): string {
  const value = input.context?.finalClaim ?? input.context?.answer;
  return typeof value === "string" ? value : "";
}

function assertsSuccess(claim: string): boolean {
  return /(全部完成|已经?完成|交付完成|成功交付|all\s+(?:work\s+)?complete|completed successfully|\bsucceeded\b|\bdone\b)/i.test(
    claim,
  );
}
