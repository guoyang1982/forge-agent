import { File, Paths } from "expo-file-system";

const DRAFT_FILE_NAME = "forge-mobile-composer-drafts.v1.json";

export type ComposerDraft = {
  hostId: string;
  sessionId: string | null;
  prompt: string;
  mentionedFiles: string[];
  updatedAt: string;
};

type DraftFile = {
  byKey: Record<string, ComposerDraft>;
};

export function draftKey(hostId: string, sessionId: string | null): string {
  return `${hostId}::${sessionId || "new"}`;
}

export async function loadComposerDraft(
  hostId: string,
  sessionId: string | null,
): Promise<ComposerDraft | null> {
  if (!hostId.trim()) return null;
  try {
    const all = await readDrafts();
    return all.byKey[draftKey(hostId, sessionId)] ?? null;
  } catch {
    return null;
  }
}

export async function saveComposerDraft(draft: ComposerDraft): Promise<void> {
  if (!draft.hostId.trim()) return;
  try {
    const all = await readDrafts();
    const key = draftKey(draft.hostId, draft.sessionId);
    const prompt = draft.prompt.slice(0, 20_000);
    const mentionedFiles = draft.mentionedFiles.slice(0, 20);
    if (!prompt.trim() && mentionedFiles.length === 0) {
      delete all.byKey[key];
    } else {
      all.byKey[key] = {
        hostId: draft.hostId,
        sessionId: draft.sessionId,
        prompt,
        mentionedFiles,
        updatedAt: draft.updatedAt || new Date().toISOString(),
      };
    }
    // Keep the map bounded.
    const keys = Object.keys(all.byKey);
    if (keys.length > 40) {
      const sorted = keys
        .map((item) => ({ key: item, at: all.byKey[item]?.updatedAt || "" }))
        .sort((a, b) => a.at.localeCompare(b.at));
      for (const stale of sorted.slice(0, keys.length - 40)) {
        delete all.byKey[stale.key];
      }
    }
    await writeDrafts(all);
  } catch {
    // best-effort
  }
}

export async function clearComposerDraft(hostId: string, sessionId: string | null): Promise<void> {
  if (!hostId.trim()) return;
  try {
    const all = await readDrafts();
    delete all.byKey[draftKey(hostId, sessionId)];
    await writeDrafts(all);
  } catch {
    // ignore
  }
}

async function readDrafts(): Promise<DraftFile> {
  const file = draftFile();
  if (!file.exists) return { byKey: {} };
  const value = JSON.parse(file.textSync()) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { byKey: {} };
  const byKey = (value as { byKey?: unknown }).byKey;
  if (!byKey || typeof byKey !== "object" || Array.isArray(byKey)) return { byKey: {} };
  return { byKey: byKey as Record<string, ComposerDraft> };
}

async function writeDrafts(value: DraftFile): Promise<void> {
  const file = draftFile();
  if (!file.exists) file.create();
  file.write(JSON.stringify(value));
}

function draftFile(): File {
  return new File(Paths.document, DRAFT_FILE_NAME);
}
