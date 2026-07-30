import { File, Paths } from "expo-file-system";
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "../ui/theme-palettes";
import {
  isThemePreference,
  type ThemePreference,
} from "../ui/theme-preference";

export type { ThemePreference } from "../ui/theme-preference";
export { isThemePreference, resolveThemePreference } from "../ui/theme-preference";

const PREFERENCES_FILE_NAME = "forge-mobile-preferences.v1.json";

export interface RunContextPreference {
  cwd?: string;
  provider?: string;
  model?: string;
  permissionMode?: string;
}

export interface MobilePreferences {
  lastHostId: string | null;
  themeId?: ThemePreference;
  notificationsEnabled?: boolean;
  /** Last composer context per host — best-effort UI memory. */
  lastRunContextByHost?: Record<string, RunContextPreference>;
  /** Soft tips for mic / photos already shown once. */
  composerTipsSeen?: boolean;
}

/**
 * Non-secret UI preference storage. Device/resume tokens must never be written
 * here (they live in SecureStore only, see host-store.ts).
 */
export async function loadPreferences(): Promise<MobilePreferences> {
  try {
    const file = preferencesFile();
    if (!file.exists) return { lastHostId: null };
    const value = JSON.parse(file.textSync()) as unknown;
    return isPreferences(value) ? value : { lastHostId: null };
  } catch {
    return { lastHostId: null };
  }
}

export async function loadLastHostId(): Promise<string | null> {
  return (await loadPreferences()).lastHostId;
}

export async function saveLastHostId(hostId: string | null): Promise<void> {
  const current = await loadPreferences();
  await writePreferences({ ...current, lastHostId: hostId });
}

export async function loadThemeId(): Promise<ThemePreference> {
  const current = await loadPreferences();
  return isThemePreference(current.themeId) ? current.themeId : DEFAULT_THEME_ID;
}

export async function saveThemeId(themeId: ThemePreference): Promise<void> {
  const current = await loadPreferences();
  await writePreferences({ ...current, themeId });
}

export async function loadNotificationsEnabled(): Promise<boolean> {
  const current = await loadPreferences();
  return current.notificationsEnabled !== false;
}

export async function saveNotificationsEnabled(enabled: boolean): Promise<void> {
  const current = await loadPreferences();
  await writePreferences({ ...current, notificationsEnabled: enabled });
}

export async function saveLastRunContext(
  hostId: string,
  context: RunContextPreference,
): Promise<void> {
  if (!hostId.trim()) return;
  const current = await loadPreferences();
  const byHost = { ...(current.lastRunContextByHost ?? {}) };
  byHost[hostId] = {
    ...(byHost[hostId] ?? {}),
    ...sanitizeContext(context),
  };
  await writePreferences({ ...current, lastRunContextByHost: byHost });
}

export async function loadLastRunContext(hostId: string): Promise<RunContextPreference | null> {
  if (!hostId.trim()) return null;
  const current = await loadPreferences();
  return current.lastRunContextByHost?.[hostId] ?? null;
}

export async function loadComposerTipsSeen(): Promise<boolean> {
  return (await loadPreferences()).composerTipsSeen === true;
}

export async function saveComposerTipsSeen(seen: boolean): Promise<void> {
  const current = await loadPreferences();
  await writePreferences({ ...current, composerTipsSeen: seen });
}

async function writePreferences(value: MobilePreferences): Promise<void> {
  try {
    const file = preferencesFile();
    if (!file.exists) file.create();
    file.write(JSON.stringify(value satisfies MobilePreferences));
  } catch {
    // Best-effort UI preference.
  }
}

function sanitizeContext(context: RunContextPreference) {
  return {
    ...(context.cwd?.trim() ? { cwd: context.cwd.trim().slice(0, 500) } : {}),
    ...(context.provider?.trim() ? { provider: context.provider.trim().slice(0, 80) } : {}),
    ...(context.model?.trim() ? { model: context.model.trim().slice(0, 120) } : {}),
    ...(context.permissionMode?.trim()
      ? { permissionMode: context.permissionMode.trim().slice(0, 80) }
      : {}),
  };
}

function preferencesFile(): File {
  return new File(Paths.document, PREFERENCES_FILE_NAME);
}

function isPreferences(value: unknown): value is MobilePreferences {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!(item.lastHostId === null || typeof item.lastHostId === "string")) return false;
  if (item.themeId !== undefined && !isThemePreference(item.themeId)) return false;
  if (item.notificationsEnabled !== undefined && typeof item.notificationsEnabled !== "boolean") {
    return false;
  }
  if (item.composerTipsSeen !== undefined && typeof item.composerTipsSeen !== "boolean") {
    return false;
  }
  if (item.lastRunContextByHost !== undefined && (
    !item.lastRunContextByHost
    || typeof item.lastRunContextByHost !== "object"
    || Array.isArray(item.lastRunContextByHost)
  )) {
    return false;
  }
  return true;
}
