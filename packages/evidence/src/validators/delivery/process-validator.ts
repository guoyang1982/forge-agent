import type {
  ValidationInput,
  ValidationResult,
  Validator,
} from "../../types.js";

export class ProcessValidator implements Validator {
  readonly id = "delivery-process";
  readonly layer = "process";

  async validate(input: ValidationInput): Promise<ValidationResult> {
    const failures = processFailureReasons(input);
    return {
      status: failures.length === 0 ? "passed" : "failed",
      layer: this.layer,
      severity: failures.length === 0 ? "info" : "blocking",
      evidenceIds: input.evidenceIds,
      summary:
        failures.length === 0
          ? "delivery process evidence and trace are current"
          : "delivery process evidence or trace is incomplete",
      details: { failures },
    };
  }
}

export function processFailureReasons(input: ValidationInput): string[] {
  const context = input.context ?? {};
  const failures: string[] = [];
  const checkpoint = readString(context.checkpointId) ?? readString(context.checkpointHash);
  if (!checkpoint) failures.push("checkpoint missing");
  if (input.artifactIds.length === 0) failures.push("delivery artifacts missing");
  if (input.evidenceIds.length === 0) failures.push("delivery evidence missing");

  const trace = context.trace ?? context.deliveryTrace;
  if (!isRecord(trace)) {
    failures.push("delivery trace missing");
  } else {
    if (trace.stale === true || trace.isStale === true) {
      failures.push("delivery trace stale");
    }
    const traceCheckpoint =
      readString(trace.checkpointId) ?? readString(trace.checkpointHash);
    if (!traceCheckpoint) {
      failures.push("delivery trace checkpoint missing");
    } else if (checkpoint && !matchesCheckpoint(context, trace)) {
      failures.push("delivery trace checkpoint mismatch");
    }
  }

  const evidence = context.evidence ?? context.evidenceRecords;
  if (Array.isArray(evidence)) {
    const staleIds = evidence
      .filter(isRecord)
      .filter((entry) => entry.stale === true || entry.isStale === true)
      .map((entry) => readString(entry.id))
      .filter((id): id is string => id !== undefined);
    if (staleIds.some((id) => input.evidenceIds.includes(id))) {
      failures.push("delivery evidence stale");
    }
  }
  return failures;
}

function matchesCheckpoint(
  context: Record<string, unknown>,
  trace: Record<string, unknown>,
): boolean {
  const id = readString(context.checkpointId);
  const hash = readString(context.checkpointHash);
  const traceId = readString(trace.checkpointId);
  const traceHash = readString(trace.checkpointHash);
  return (id !== undefined && id === traceId) || (hash !== undefined && hash === traceHash);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
