import { File, Paths } from "expo-file-system";

const HIDDEN_SESSIONS_FILE = "forge-mobile-hidden-sessions.v1.json";

type HiddenStore = {
  ids: string[];
};

export async function loadHiddenSessionIds(): Promise<string[]> {
  try {
    const file = hiddenFile();
    if (!file.exists) return [];
    const value = JSON.parse(file.textSync()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const ids = (value as HiddenStore).ids;
    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string").slice(0, 500)
      : [];
  } catch {
    return [];
  }
}

export async function hideSessionId(sessionId: string): Promise<string[]> {
  const id = sessionId.trim();
  if (!id) return loadHiddenSessionIds();
  const current = await loadHiddenSessionIds();
  if (current.includes(id)) return current;
  const next = [id, ...current].slice(0, 500);
  await writeHidden(next);
  return next;
}

export async function unhideSessionId(sessionId: string): Promise<string[]> {
  const target = sessionId.trim();
  if (!target) return loadHiddenSessionIds();
  const next = (await loadHiddenSessionIds()).filter((id) => id !== target);
  await writeHidden(next);
  return next;
}

export async function clearHiddenSessionIds(): Promise<string[]> {
  await writeHidden([]);
  return [];
}

async function writeHidden(ids: string[]): Promise<void> {
  try {
    const file = hiddenFile();
    if (!file.exists) file.create();
    file.write(JSON.stringify({ ids } satisfies HiddenStore));
  } catch {
    // best-effort local hide
  }
}

function hiddenFile(): File {
  return new File(Paths.document, HIDDEN_SESSIONS_FILE);
}
