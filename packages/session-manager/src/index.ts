import { join } from "node:path";
import { SessionStore, type CompactSessionResult, type SessionSummary } from "@forge/session";
import { openNonMigratingDatabase } from "@forge/store";

export interface SessionManagerOptions {
  dataDir: string;
}

export class SessionManager {
  private readonly store: SessionStore;

  constructor(options: SessionManagerOptions) {
    this.store = new SessionStore(
      openNonMigratingDatabase(join(options.dataDir, "data.db")),
    );
  }

  list(limit = 10): SessionSummary[] {
    return this.store.listSessions(limit);
  }

  getCwd(sessionId: string): string | null {
    return this.store.getSessionCwd(sessionId);
  }

  compact(sessionId: string, keepLast = 30): CompactSessionResult {
    return this.store.compactSession(sessionId, keepLast);
  }

  close(): void {
    this.store.close();
  }
}

export function formatSessionsList(
  sessions: SessionSummary[],
  activeSessionId?: string | null,
): string {
  if (!sessions.length) return "(no sessions)";

  return sessions
    .map((session) => {
      const active = session.id === activeSessionId ? "*" : " ";
      const shortId = session.id.slice(0, 8);
      const updated = session.updatedAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
      const preview = session.lastPreview ? `\n    ${session.lastPreview}` : "";
      return `${active} ${shortId}  ${session.messageCount} msgs  ${updated}\n    ${session.cwd}${preview}`;
    })
    .join("\n");
}
