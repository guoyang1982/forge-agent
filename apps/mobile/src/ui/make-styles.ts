import { useMemo } from "react";
import { StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from "react-native";
import { useTheme, type ThemeColors } from "./theme";

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

/**
 * Build theme-aware styles. Call the returned hook inside each component so
 * palettes recompute when the user switches theme.
 */
export function makeStyles<T extends NamedStyles<T>>(
  factory: (colors: ThemeColors) => T | NamedStyles<T>,
): () => T {
  return function useStyles(): T {
    const { colors, themeId } = useTheme();
    return useMemo(
      () => StyleSheet.create(factory(colors)) as T,
      [colors, themeId],
    );
  };
}
