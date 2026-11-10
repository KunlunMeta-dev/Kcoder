import { useMemo, useSyncExternalStore } from "react";
import { Appearance } from "react-native";
import { useInterfaceVersion } from "@/storage/interface-version";
import { classicPalette } from "@/features/interface/classic-colors";

export type ThemeMode = "light" | "dark";
export type ThemePreference = "system" | ThemeMode;

export interface ThemeColors {
  pageCanvas: string;
  actionPrimary: string;
  actionPrimaryDisabled: string;
  actionPrimaryText: string;
  actionTint: string;
  background: string;
  surface: string;
  surfaceRaised: string;
  surfaceHover: string;
  userMessageSurface: string;
  userMessageBorder: string;
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
  settingsPageBackground: string;
  settingsGroupBackground: string;
}

export const darkColors: ThemeColors = {
  pageCanvas: "#18181B",
  actionPrimary: "#559DE0",
  actionPrimaryDisabled: "#345574",
  actionPrimaryText: "#FFFFFF",
  actionTint: "#243B52",
  background: "#18181B",
  surface: "#202024",
  surfaceRaised: "#2B2B30",
  surfaceHover: "#27272A",
  userMessageSurface: "#29292E",
  userMessageBorder: "#3A3A41",
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
  settingsPageBackground: "#18181B",
  settingsGroupBackground: "#202024",
};

export const lightColors: ThemeColors = {
  pageCanvas: "#F7F9F6",
  actionPrimary: "#4C95DA",
  actionPrimaryDisabled: "#B8D4EF",
  actionPrimaryText: "#FFFFFF",
  actionTint: "#DFEBF7",
  background: "#FFFFFF",
  surface: "#F1F4F0",
  surfaceRaised: "#FFFFFF",
  surfaceHover: "#EDF1EC",
  userMessageSurface: "#F3F6F1",
  userMessageBorder: "#E2E7E0",
  surfaceSidebar: "#F7F9F6",
  border: "#E2E7E0",
  borderAccent: "#7E887F",
  text: "#1F2722",
  textMuted: "#56615B",
  textDim: "#78847D",
  accent: "#18181B",
  accentBright: "#2563EB",
  accentText: "#FAFAFA",
  blue: "#2563EB",
  green: "#15803D",
  yellow: "#9A5E07",
  red: "#B91C1C",
  overlay: "rgba(15,23,42,0.40)",
  settingsPageBackground: "#F4F4F5",
  settingsGroupBackground: "#FFFFFF",
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
  chatMessage: 22,
  chatOutputGroup: 18,
  chatComposer: 28,
  pill: 999,
  settingsGroup: 20,
} as const;

export const chatTypography = {
  body: { fontSize: 17, lineHeight: 28, letterSpacing: 0.2 },
  step: { fontSize: 16, lineHeight: 24, letterSpacing: 0.2 },
  status: { fontSize: 12, lineHeight: 18 },
  inlineCode: { fontSize: 15, letterSpacing: 0 },
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
  const version = useInterfaceVersion();
  const current = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeSnapshot,
  );
  const palette = useMemo(() => version === "classic" ? classicPalette(current.mode, current.colors) : current.colors,
    [version, current.mode, current.colors]);
  return { colors: palette, mode: current.mode };
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
