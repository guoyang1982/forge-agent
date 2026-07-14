import type { SessionHookSource } from "./types.js";

export interface HookSessionState {
  touchSession(sessionId: string): void;
  getTouchedSessionIds(): string[];
  setPendingHookSource(sessionId: string, source: SessionHookSource): void;
  consumePendingHookSource(sessionId: string): SessionHookSource | undefined;
  resolveSessionHookSource(options: {
    explicit?: SessionHookSource;
    sessionId: string;
    hasHistory: boolean;
  }): SessionHookSource;
}

export function createHookSessionState(): HookSessionState {
  const touchedSessions = new Set<string>();
  const pendingHookSourceBySession = new Map<string, SessionHookSource>();

  return {
    touchSession(sessionId: string) {
      if (sessionId) touchedSessions.add(sessionId);
    },
    getTouchedSessionIds() {
      return [...touchedSessions];
    },
    setPendingHookSource(sessionId: string, source: SessionHookSource) {
      if (sessionId) pendingHookSourceBySession.set(sessionId, source);
    },
    consumePendingHookSource(sessionId: string) {
      const source = pendingHookSourceBySession.get(sessionId);
      if (source) pendingHookSourceBySession.delete(sessionId);
      return source;
    },
    resolveSessionHookSource(options) {
      return (
        options.explicit ??
        this.consumePendingHookSource(options.sessionId) ??
        (options.hasHistory ? "resume" : "startup")
      );
    },
  };
}

/** Process-wide hook session tracking for the Forge daemon. */
export const hookSessionState = createHookSessionState();
