export interface PermissionDecision {
  approved: boolean;
  /** "Always allow for this session" was chosen. */
  remember: boolean;
  /** ACP permission option selected by the user. */
  optionId?: string;
  /**
   * Set when the waiter ended without a user respondPermission call.
   * Callers should emit `permission_dismissed` so UIs clear stale banners.
   */
  dismissReason?: "timeout" | "abort" | "cancelled";
}

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class PermissionService {
  private pending = new Map<string, PendingPermission>();
  /** Sessions that chose "always allow commands". */
  private commandAllowedSessions = new Set<string>();

  waitForResponse(
    id: string,
    options?: { timeoutMs?: number; sessionId?: string; signal?: AbortSignal },
  ): Promise<PermissionDecision> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      const finish = (decision: PermissionDecision) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        options?.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        resolve(decision);
      };

      const onAbort = () =>
        finish({ approved: false, remember: false, dismissReason: "abort" });
      const timer = setTimeout(
        () => finish({ approved: false, remember: false, dismissReason: "timeout" }),
        timeoutMs,
      );
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve: finish,
        timer,
        sessionId: options?.sessionId,
      });

      if (options?.signal?.aborted) {
        finish({ approved: false, remember: false, dismissReason: "abort" });
      }
    });
  }

  respond(
    id: string,
    approved: boolean,
    remember = false,
    optionId?: string,
  ): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.resolve({ approved, remember, optionId });
    return true;
  }

  isCommandAllowed(sessionId: string): boolean {
    return this.commandAllowedSessions.has(sessionId);
  }

  allowCommandsForSession(sessionId: string): void {
    if (sessionId) this.commandAllowedSessions.add(sessionId);
  }

  /** Resolve all waiters for a session as denied; returns dismissed ids. */
  cancelSession(sessionId: string): string[] {
    const dismissed: string[] = [];
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.sessionId === sessionId) {
        dismissed.push(id);
        entry.resolve({
          approved: false,
          remember: false,
          dismissReason: "cancelled",
        });
      }
    }
    return dismissed;
  }
}

export const permissionService = new PermissionService();
