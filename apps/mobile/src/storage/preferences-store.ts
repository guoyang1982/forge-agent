import { File, Paths } from "expo-file-system";

const PREFERENCES_FILE_NAME = "forge-mobile-preferences.v1.json";

export interface MobilePreferences {
  lastHostId: string | null;
}

/**
 * Non-secret UI preference storage. Only `lastHostId` is persisted here; device
 * and resume tokens must never be written to this file (they live in
 * SecureStore only, see host-store.ts).
 */
export async function loadLastHostId(): Promise<string | null> {
  try {
    const file = preferencesFile();
    if (!file.exists) return null;
    const value = JSON.parse(file.textSync()) as unknown;
    return isPreferences(value) ? value.lastHostId : null;
  } catch {
    return null;
  }
}

export async function saveLastHostId(hostId: string | null): Promise<void> {
  try {
    const file = preferencesFile();
    if (!file.exists) file.create();
    file.write(JSON.stringify({ lastHostId: hostId } satisfies MobilePreferences));
  } catch {
    // Best-effort UI preference; losing it only affects auto-selection on next launch.
  }
}

function preferencesFile(): File {
  return new File(Paths.document, PREFERENCES_FILE_NAME);
}

function isPreferences(value: unknown): value is MobilePreferences {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.lastHostId === null || typeof item.lastHostId === "string";
}
