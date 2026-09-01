import { exportTraceEvalFixture, type TraceContext } from "@forge/execution";
import type { RegressionCandidate } from "./types.js";

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|api[_-]?key|authorization|credential)/i;

export interface RegressionCandidateInput {
  suiteId: string;
  caseId: string;
  trace: TraceContext;
  validators: string[];
  failureReason?: string;
  sensitiveData?: Record<string, unknown>;
}

export function createRegressionCandidate(
  input: RegressionCandidateInput,
): RegressionCandidate {
  const traceFixture = exportTraceEvalFixture(input.trace);
  const redactedPayload = redactPayload({
    traceFixture,
    failureReason: input.failureReason,
    sensitiveData: input.sensitiveData,
  });

  return {
    suiteId: input.suiteId,
    caseId: input.caseId,
    traceFixture,
    validators: [...input.validators],
    failureSummary: input.failureReason ?? "eval case failed",
    redactedPayload,
  };
}

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactValue(payload) as Record<string, unknown>;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = "[REDACTED]";
        continue;
      }
      output[key] = redactValue(entry);
    }
    return output;
  }

  if (typeof value === "string" && looksSensitiveString(value)) {
    return "[REDACTED]";
  }

  return value;
}

function looksSensitiveString(value: string): boolean {
  return /secret-token|bearer\s+[a-z0-9._-]+/i.test(value);
}

export { redactPayload, looksSensitiveString };
