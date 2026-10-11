import { afterEach, describe, expect, it, vi } from "vitest";

const appearance = vi.hoisted(() => ({
  colorScheme: "dark" as "light" | "dark" | null,
  listener: null as ((event: { colorScheme: "light" | "dark" | null }) => void) | null,
  remove: vi.fn(),
}));

vi.mock("react-native", () => ({
  Appearance: {
    getColorScheme: () => appearance.colorScheme,
    addChangeListener: (listener: typeof appearance.listener) => {
      appearance.listener = listener;
      return {
        remove: () => {
          appearance.remove();
          appearance.listener = null;
        },
      };
    },
  },
}));

import {
  darkColors,
  getThemeSnapshot,
  initTheme,
  lightColors,
  refreshSystemTheme,
  setThemePreference,
  subscribeTheme,
  themeTestHelpers,
} from "./theme";

function relativeLuminance(color: string): number {
  const channels = color.match(/[0-9a-f]{2}/gi)?.map((value) => parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Expected hex RGB color, got ${color}`);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
    .sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

afterEach(() => {
  themeTestHelpers.reset();
  appearance.colorScheme = "dark";
  appearance.remove.mockClear();
});

describe("mobile theme", () => {
  it("provides matching light and dark color tokens", () => {
    expect(Object.keys(lightColors).sort()).toEqual(Object.keys(darkColors).sort());
    expect(lightColors.background).not.toBe(darkColors.background);
    expect(lightColors.text).not.toBe(darkColors.text);
  });

  it.each([
    ["light", lightColors],
    ["dark", darkColors],
  ] as const)("keeps %s control outlines distinct from their surfaces", (_mode, colors) => {
    for (const surface of [colors.surface, colors.surfaceRaised, colors.background]) {
      expect(contrastRatio(colors.borderAccent, surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it("follows system appearance until an explicit mode is selected", () => {
    initTheme("system");
    expect(getThemeSnapshot().mode).toBe("dark");
    const listener = vi.fn();
    const unsubscribe = subscribeTheme(listener);

    appearance.colorScheme = "light";
    appearance.listener?.({ colorScheme: "light" });
    expect(getThemeSnapshot().mode).toBe("light");
    expect(listener).toHaveBeenCalledTimes(1);

    setThemePreference("dark");
    appearance.colorScheme = "light";
    refreshSystemTheme();
    expect(getThemeSnapshot().mode).toBe("dark");

    unsubscribe();
    expect(appearance.remove).toHaveBeenCalledTimes(1);
  });
});
