import type { ITheme } from "@xterm/xterm";
import type { ThemeColors, ThemeMode } from "@/theme";

export type TerminalTheme = ITheme;

/** Build the xterm palette from the resolved mobile appearance. */
export function createTerminalTheme(
  mode: ThemeMode,
  colors: ThemeColors,
): TerminalTheme {
  const light = mode === "light";

  return {
    background: colors.surface,
    foreground: colors.text,
    cursor: colors.accentBright,
    cursorAccent: colors.surface,
    selectionBackground: light ? "#BFDBFE" : "#365F7D",
    selectionInactiveBackground: light ? "#DBEAFE" : "#293F52",
    selectionForeground: colors.text,
    scrollbarSliderBackground: light
      ? "rgba(100, 116, 139, 0.28)"
      : "rgba(161, 161, 170, 0.28)",
    scrollbarSliderHoverBackground: light
      ? "rgba(71, 85, 105, 0.42)"
      : "rgba(212, 212, 216, 0.42)",
    scrollbarSliderActiveBackground: light
      ? "rgba(51, 65, 85, 0.55)"
      : "rgba(228, 228, 231, 0.55)",
    black: light ? "#334155" : "#101114",
    red: light ? colors.red : "#FB7185",
    green: light ? colors.green : "#4ADE80",
    yellow: light ? colors.yellow : "#FACC15",
    blue: light ? colors.blue : "#60A5FA",
    magenta: light ? "#A21CAF" : "#C084FC",
    cyan: light ? "#0E7490" : "#22D3EE",
    white: light ? "#475569" : "#E5E7EB",
    brightBlack: light ? "#64748B" : "#71717A",
    brightRed: light ? "#DC2626" : "#FDA4AF",
    brightGreen: light ? "#166534" : "#86EFAC",
    brightYellow: light ? "#854D0E" : "#FDE68A",
    brightBlue: light ? "#1D4ED8" : "#93C5FD",
    brightMagenta: light ? "#86198F" : "#D8B4FE",
    brightCyan: light ? "#155E75" : "#67E8F9",
    brightWhite: light ? "#0F172A" : "#FFFFFF",
  };
}
