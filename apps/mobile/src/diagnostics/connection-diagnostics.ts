export interface ConnectionDiagnostic {
  id: string;
  at: string;
  hostId: string;
  level: "info" | "warn" | "error";
  event: string;
  message: string;
}

let diagnosticSequence = 0;

export function diagnosticEntry(input: {
  hostId: string;
  level: ConnectionDiagnostic["level"];
  event: string;
  message?: string;
  now?: Date;
}): ConnectionDiagnostic {
  const at = (input.now ?? new Date()).toISOString();
  return {
    id: `${at}:${input.hostId}:${input.event}:${diagnosticSequence++}`,
    at,
    hostId: safeHostId(input.hostId),
    level: input.level,
    event: sanitizeText(input.event).slice(0, 80),
    message: sanitizeText(input.message ?? "").slice(0, 300),
  };
}

export function retryDelayMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(Math.max(0, attempt), 6));
  return Math.min(30_000, base + Math.floor(random() * Math.max(100, base / 3)));
}

export function shouldRetryConnection(message: string): boolean {
  return !/凭证已失效|重新配对|安全校验失败|credential|unauthor|forbidden|identity|transcript|decrypt|protocol/i.test(
    message,
  );
}

export function sanitizeText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:device|resume|invite)_[A-Za-z0-9_-]{16,}\b/g, "[credential]")
    .replace(/([?&](?:code|token|credential|secret)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{43,}\b/g, "[opaque]");
}

function safeHostId(hostId: string): string {
  if (hostId.length <= 14) return sanitizeText(hostId);
  return `${hostId.slice(0, 8)}…${hostId.slice(-4)}`;
}
