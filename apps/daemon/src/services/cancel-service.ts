export class CancelService {
  private runs = new Map<string, AbortController>();

  /** Register a run for one session; only replaces an existing run for the same sessionId. */
  registerRun(sessionId: string): AbortController {
    this.runs.get(sessionId)?.abort();
    const abort = new AbortController();
    this.runs.set(sessionId, abort);
    return abort;
  }

  clearRun(sessionId: string, abort: AbortController): void {
    if (this.runs.get(sessionId) === abort) {
      this.runs.delete(sessionId);
    }
  }

  cancel(sessionId?: string): { ok: true; canceled: boolean } {
    if (sessionId) {
      const abort = this.runs.get(sessionId);
      if (!abort) return { ok: true, canceled: false };
      abort.abort();
      return { ok: true, canceled: true };
    }
    const canceled = this.runs.size > 0;
    for (const abort of this.runs.values()) {
      abort.abort();
    }
    return { ok: true, canceled };
  }

  hasActiveRun(): boolean {
    return this.runs.size > 0;
  }

  hasActiveRunForSession(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  activeSessionIds(): string[] {
    return [...this.runs.keys()];
  }
}
