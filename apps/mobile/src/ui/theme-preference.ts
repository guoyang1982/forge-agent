import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "../ui/theme-palettes";

export type ThemePreference = ThemeId | "system";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || isThemeId(value);
}

export function resolveThemePreference(
  preference: ThemePreference,
  scheme: "light" | "dark" | "unspecified" | null | undefined,
): ThemeId {
  if (preference !== "system") return preference;
  return scheme === "light" ? "forge-light" : "forge-dark";
}

export { DEFAULT_THEME_ID };
