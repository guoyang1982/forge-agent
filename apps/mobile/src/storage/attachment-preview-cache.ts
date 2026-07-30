import { File, Paths } from "expo-file-system";
import {
  applyAttachmentPreviews,
  normalizeSessionPreviews,
  prunePreviewStore,
  stripMissingLocalUris,
  type AttachmentPreview,
  type PreviewStoreShape,
} from "./attachment-preview-policy";

const PREVIEW_FILE = "forge-mobile-attachment-previews.v1.json";
export { applyAttachmentPreviews };
export type { AttachmentPreview };

export async function saveSessionAttachmentPreviews(
  sessionId: string,
  previews: AttachmentPreview[],
): Promise<void> {
  const id = sessionId.trim();
  if (!id || !previews.length) return;
  try {
    const all = await readStore();
    const now = Date.now();
    const existing = all.bySession[id] ?? [];
    all.bySession[id] = normalizeSessionPreviews(existing, previews, now);
    all.updatedAtBySession = { ...(all.updatedAtBySession ?? {}), [id]: now };
    await writeStore(prunePreviewStore(all));
  } catch {
    // best-effort
  }
}

export async function loadSessionAttachmentPreviews(sessionId: string): Promise<AttachmentPreview[]> {
  const id = sessionId.trim();
  if (!id) return [];
  try {
    const all = await readStore();
    const normalized = normalizeSessionPreviews([], all.bySession[id] ?? [], Date.now());
    const alive = stripMissingLocalUris(normalized, localUriExists);
    if (alive.length !== normalized.length) {
      // Persist cleanup so we stop probing missing files every history load.
      all.bySession[id] = alive;
      if (!alive.length) {
        delete all.bySession[id];
        if (all.updatedAtBySession) delete all.updatedAtBySession[id];
      }
      await writeStore(prunePreviewStore(all));
    }
    return alive;
  } catch {
    return [];
  }
}

function localUriExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

async function readStore(): Promise<PreviewStoreShape> {
  const file = previewFile();
  if (!file.exists) return { bySession: {}, updatedAtBySession: {} };
  const value = JSON.parse(file.textSync()) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { bySession: {}, updatedAtBySession: {} };
  }
  const bySession = (value as PreviewStoreShape).bySession;
  if (!bySession || typeof bySession !== "object" || Array.isArray(bySession)) {
    return { bySession: {}, updatedAtBySession: {} };
  }
  const updatedAtBySession = (value as PreviewStoreShape).updatedAtBySession;
  return {
    bySession,
    updatedAtBySession:
      updatedAtBySession && typeof updatedAtBySession === "object" && !Array.isArray(updatedAtBySession)
        ? updatedAtBySession
        : {},
  };
}

async function writeStore(store: PreviewStoreShape): Promise<void> {
  const file = previewFile();
  if (!file.exists) file.create();
  file.write(JSON.stringify(store));
}

function previewFile(): File {
  return new File(Paths.document, PREVIEW_FILE);
}
