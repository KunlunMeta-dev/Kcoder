// V1 palettes; new semantic tokens keep the current shared controls available.
import type { ThemeColors, ThemeMode } from "@/theme";
const light = {
  background: "#FFFFFF",
  surface: "#F8FAFC",
  surfaceRaised: "#FFFFFF",
  surfaceHover: "#F1F5F9",
  userMessageSurface: "#F3F4F6",
  userMessageBorder: "#D9DDE2",
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
  settingsPageBackground: "#F4F4F5",
  settingsGroupBackground: "#FFFFFF",
};
const dark = {
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
export function classicPalette(mode: ThemeMode, current: ThemeColors): ThemeColors {
 const palette = mode === "light" ? light : dark;
 return { ...current, ...palette, pageCanvas: palette.background, actionPrimary: palette.accent, actionPrimaryText: palette.accentText, actionPrimaryDisabled: palette.surfaceRaised };
}
