export interface ExecutionClock {
  now(): string;
  nowMs(): number;
}

export class ManualTestClock implements ExecutionClock {
  private currentMs: number;

  constructor(iso = "2026-01-01T00:00:00.000Z") {
    this.currentMs = Date.parse(iso);
  }

  now(): string {
    return new Date(this.currentMs).toISOString();
  }

  nowMs(): number {
    return this.currentMs;
  }

  advanceBy(ms: number): void {
    this.currentMs += ms;
  }
}
