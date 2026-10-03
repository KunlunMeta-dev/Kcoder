export const colors = {
  // Use a consistent teal hierarchy in the default dark theme. Mobile defaults to
  // dark mode so Web previews and native shells share one visual language on first launch.
  background: "#181B1A",
  surface: "#1E2120",
  surfaceRaised: "#272A29",
  surfaceHover: "#1C1F1E",
  surfaceSidebar: "#141716",
  border: "#252B2A",
  borderAccent: "#2F3534",
  text: "#FAFAFA",
  textMuted: "#A1A5A4",
  textDim: "#8B908E",
  accent: "#20744A",
  accentBright: "#7CCBA0",
  accentText: "#ffffff",
  blue: "#6A9DE0",
  green: "#22C55E",
  yellow: "#F59E0B",
  red: "#C64F43",
  overlay: "rgba(0,0,0,0.72)",
} as const;

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
