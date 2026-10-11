import { useMemo, useSyncExternalStore } from "react";
import { Appearance } from "react-native";

export type ThemeMode = "light" | "dark";
export type ThemePreference = "system" | ThemeMode;

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceRaised: string;
  surfaceHover: string;
  surfaceSidebar: string;
  border: string;
  borderAccent: string;
  text: string;
  textMuted: string;
  textDim: string;
  accent: string;
  accentBright: string;
  accentText: string;
  blue: string;
  green: string;
  yellow: string;
  red: string;
  overlay: string;
}

export const darkColors: ThemeColors = {
  background: "#18181B",
  surface: "#202024",
  surfaceRaised: "#2B2B30",
  surfaceHover: "#27272A",
  surfaceSidebar: "#141416",
  border: "#34343B",
  borderAccent: "#777780",
  text: "#FAFAFA",
  textMuted: "#A1A1AA",
  textDim: "#85858F",
  accent: "#FAFAFA",
  accentBright: "#93C5FD",
  accentText: "#18181B",
  blue: "#6A9DE0",
  green: "#22C55E",
  yellow: "#F59E0B",
  red: "#C64F43",
  overlay: "rgba(0,0,0,0.72)",
};

export const lightColors: ThemeColors = {
  background: "#FFFFFF",
  surface: "#F8FAFC",
  surfaceRaised: "#FFFFFF",
  surfaceHover: "#F1F5F9",
  surfaceSidebar: "#F8FAFC",
  border: "#E4E4E7",
  borderAccent: "#909098",
  text: "#18181B",
  textMuted: "#52525B",
  textDim: "#71717A",
  accent: "#18181B",
  accentBright: "#2563EB",
  accentText: "#FAFAFA",
  blue: "#2563EB",
  green: "#15803D",
  yellow: "#A16207",
  red: "#B91C1C",
  overlay: "rgba(15,23,42,0.40)",
};

/** Return the stable palette for a resolved mode. */
export function createPalette(mode: ThemeMode): ThemeColors {
  return mode === "light" ? lightColors : darkColors;
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  pill: 999,
} as const;

export interface ThemeSnapshot {
  preference: ThemePreference;
  mode: ThemeMode;
  colors: ThemeColors;
}

function readSystemMode(): ThemeMode {
  return Appearance.getColorScheme() === "light" ? "light" : "dark";
}

const initialMode = readSystemMode();
let snapshot: ThemeSnapshot = {
  preference: "system",
  mode: initialMode,
  colors: createPalette(initialMode),
};
const listeners = new Set<() => void>();
let appearanceSubscription: { remove(): void } | null = null;

function modeFor(preference: ThemePreference): ThemeMode {
  return preference === "system" ? readSystemMode() : preference;
}

function publish(preference: ThemePreference): void {
  const mode = modeFor(preference);
  if (snapshot.preference === preference && snapshot.mode === mode) return;
  snapshot = { preference, mode, colors: createPalette(mode) };
  for (const listener of listeners) listener();
}

export function initTheme(preference: ThemePreference = "system"): void {
  if (preference !== "system" && preference !== "light" && preference !== "dark") {
    publish("system");
    return;
  }
  publish(preference);
}

export function setThemePreference(preference: ThemePreference): void {
  if (preference !== "system" && preference !== "light" && preference !== "dark")
    return;
  publish(preference);
}

export function getThemePreference(): ThemePreference {
  return snapshot.preference;
}

export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot;
}

export function refreshSystemTheme(): void {
  if (snapshot.preference === "system") publish("system");
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    appearanceSubscription = Appearance.addChangeListener(() => {
      refreshSystemTheme();
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      appearanceSubscription?.remove();
      appearanceSubscription = null;
    }
  };
}

export function useTheme(): Pick<ThemeSnapshot, "colors" | "mode"> {
  const current = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeSnapshot,
  );
  return { colors: current.colors, mode: current.mode };
}

export function useThemedStyles<T>(
  factory: (colors: ThemeColors) => T,
): T {
  const { colors } = useTheme();
  return useMemo(() => factory(colors), [colors, factory]);
}

/**
 * Static consumers such as terminal HTML use the dark palette until they can
 * pass a resolved palette through their own runtime boundary.
 */
export const colors = darkColors;

export const themeTestHelpers = {
  reset(): void {
    appearanceSubscription?.remove();
    appearanceSubscription = null;
    listeners.clear();
    const mode = readSystemMode();
    snapshot = {
      preference: "system",
      mode,
      colors: createPalette(mode),
    };
  },
};
