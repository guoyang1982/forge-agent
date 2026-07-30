import type { MessageAttachment, MessageItem } from "../screens/session-sanitize";

const SESSION_PREVIEW_LIMIT = 80;
const SESSION_STORE_LIMIT = 40;
const PREVIEW_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type AttachmentPreview = {
  kind: "image" | "file";
  name: string;
  localUri?: string;
  updatedAt?: number;
};

export type PreviewStoreShape = {
  bySession: Record<string, AttachmentPreview[]>;
  updatedAtBySession?: Record<string, number>;
};

export function normalizeSessionPreviews(
  existing: AttachmentPreview[],
  incoming: AttachmentPreview[],
  now = Date.now(),
): AttachmentPreview[] {
  const combined = [...existing, ...incoming]
    .map((item) => sanitizePreview(item, now))
    .filter((item): item is AttachmentPreview => Boolean(item))
    .filter((item) => !isExpired(item.updatedAt ?? now, now));
  const ranked = combined.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const deduped: AttachmentPreview[] = [];
  const seen = new Set<string>();
  for (const item of ranked) {
    const key = signature(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= SESSION_PREVIEW_LIMIT) break;
  }
  return deduped;
}

export function prunePreviewStore(store: PreviewStoreShape): PreviewStoreShape {
  const updated = store.updatedAtBySession ?? {};
  const sessions = Object.keys(store.bySession)
    .filter((id) => store.bySession[id]?.length)
    .sort((a, b) => (updated[b] ?? 0) - (updated[a] ?? 0))
    .slice(0, SESSION_STORE_LIMIT);
  return {
    bySession: Object.fromEntries(sessions.map((id) => [id, store.bySession[id] ?? []])),
    updatedAtBySession: Object.fromEntries(sessions.map((id) => [id, updated[id] ?? 0])),
  };
}

/**
 * Drop previews whose localUri no longer resolves on disk.
 * Entries without a usable localUri are removed (they cannot render thumbnails).
 */
export function stripMissingLocalUris(
  previews: AttachmentPreview[],
  exists: (localUri: string) => boolean,
): AttachmentPreview[] {
  return previews.filter((item) => {
    const uri = item.localUri?.trim();
    if (!uri) return false;
    try {
      return exists(uri);
    } catch {
      return false;
    }
  });
}

/** Merge cached local URIs onto history messages that only have placeholders. */
export function applyAttachmentPreviews(messages: MessageItem[], previews: AttachmentPreview[]): MessageItem[] {
  if (!previews.length) return messages;
  const unused = previews.filter((preview) => preview.localUri);
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const attachments = message.attachments?.length ? message.attachments : inferAttachmentsFromText(message.text);
    if (!attachments.length) return message;
    const next = attachments.map((att) => {
      if (att.localUri) return att;
      const index = findBestMatch(att, unused);
      if (index < 0) return att;
      const [preview] = unused.splice(index, 1);
      if (!preview?.localUri) return att;
      return { ...att, localUri: preview.localUri, name: att.name || preview.name };
    });
    return { ...message, attachments: next };
  });
}

function findBestMatch(att: MessageAttachment, previews: AttachmentPreview[]): number {
  let bestIndex = -1;
  let bestScore = -1;
  for (let index = 0; index < previews.length; index += 1) {
    const preview = previews[index];
    if (!preview || preview.kind !== att.kind) continue;
    const score = matchScore(att, preview);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function matchScore(att: MessageAttachment, preview: AttachmentPreview): number {
  if (!att.name) return 1;
  if (att.name === preview.name) return 4;
  if (basename(att.name) === basename(preview.name || "")) return 3;
  return 0;
}

function inferAttachmentsFromText(text: string): MessageAttachment[] {
  if (!/请查看附件|\[图片|image_url/i.test(text)) return [];
  return [{ kind: "image", name: "图片附件" }];
}

function sanitizePreview(item: AttachmentPreview, now: number): AttachmentPreview | null {
  const name = typeof item?.name === "string" ? item.name.trim().slice(0, 180) : "";
  if (!name) return null;
  if (item.kind !== "image" && item.kind !== "file") return null;
  const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : now;
  return {
    kind: item.kind,
    name,
    ...(item.localUri ? { localUri: item.localUri } : {}),
    updatedAt,
  };
}

function signature(item: AttachmentPreview): string {
  return `${item.kind}:${basename(item.name).toLowerCase()}`;
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function isExpired(updatedAt: number, now: number): boolean {
  return updatedAt < now - PREVIEW_TTL_MS;
}
