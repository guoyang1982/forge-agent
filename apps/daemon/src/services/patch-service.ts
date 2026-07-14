import { applyPendingPatch } from "@forge/tools";
import { WorkspaceGuard, restoreWorkspaceSnapshot } from "@forge/workspace";
import type { SessionStore } from "@forge/session";

export async function handleApplyPatch(params: unknown): Promise<unknown> {
  const { cwd, path, unifiedDiff } = params as {
    cwd: string;
    path: string;
    unifiedDiff: string;
  };
  const guard = new WorkspaceGuard(cwd);
  const result = await applyPendingPatch(guard, path, unifiedDiff);
  return JSON.parse(result);
}

export async function handleRestoreCheckpoint(
  params: unknown,
  deps: { sessions: SessionStore },
): Promise<unknown> {
  const { cwd, sha, sessionId, turnIndex, truncateConversation } = params as {
    cwd: string;
    sha: string;
    sessionId?: string;
    turnIndex?: number;
    truncateConversation?: boolean;
  };
  const guard = new WorkspaceGuard(cwd);
  const result = await restoreWorkspaceSnapshot(guard, sha);
  if (
    result.ok &&
    truncateConversation &&
    sessionId &&
    Number.isInteger(turnIndex)
  ) {
    const { removed } = deps.sessions.truncateAfterTurn(sessionId, turnIndex!);
    return { ...result, truncatedMessages: removed };
  }
  return result;
}
