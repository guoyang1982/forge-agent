import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import {
  DEFAULT_THEME_ID,
  THEME_BY_ID,
  THEME_DEFINITIONS,
  isThemeId,
  type ThemeColors,
  type ThemeId,
} from "./theme-palettes";

export type { ThemeColors, ThemeId } from "./theme-palettes";
export { THEME_DEFINITIONS, THEME_BY_ID, DEFAULT_THEME_ID, isThemeId } from "./theme-palettes";

export type ThemePreference = ThemeId | "system";

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radii = { sm: 10, md: 12, lg: 16, sheet: 22, pill: 999 };
export const minTouchStyle = { minHeight: 44 };

type ThemeContextValue = {
  /** Resolved palette currently applied. */
  themeId: ThemeId;
  /** User preference, may be "system". */
  preference: ThemePreference;
  colors: ThemeColors;
  mode: "dark" | "light";
  setThemeId: (id: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Mutable fallback while module-level styles still read `colors.*`. */
let activeColors: ThemeColors = THEME_BY_ID[DEFAULT_THEME_ID].colors;

/**
 * Compatibility export for existing StyleSheet modules.
 * Screens migrated to `makeStyles` / `useTheme` update live; legacy sheets
 * refresh when the app tree remounts with a new theme key.
 */
export const colors: ThemeColors = new Proxy({} as ThemeColors, {
  get(_target, prop: string | symbol) {
    return Reflect.get(activeColors, prop);
  },
});

export function ThemeProvider(props: {
  themeId: ThemeId;
  preference: ThemePreference;
  onThemeIdChange: (id: ThemePreference) => void;
  children: ReactNode;
}) {
  const definition = THEME_BY_ID[props.themeId] ?? THEME_BY_ID[DEFAULT_THEME_ID];
  activeColors = definition.colors;

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeId: definition.id,
      preference: props.preference,
      colors: definition.colors,
      mode: definition.mode,
      setThemeId: props.onThemeIdChange,
    }),
    [definition.id, definition.mode, definition.colors, props.preference, props.onThemeIdChange],
  );

  return createElement(ThemeContext.Provider, { value }, props.children);
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    const definition = THEME_BY_ID[DEFAULT_THEME_ID];
    return {
      themeId: definition.id,
      preference: definition.id,
      colors: definition.colors,
      mode: definition.mode,
      setThemeId: () => undefined,
    };
  }
  return value;
}

export function useThemeColors(): ThemeColors {
  return useTheme().colors;
}

export function resolveThemeId(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_THEME_ID;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || isThemeId(value);
}
