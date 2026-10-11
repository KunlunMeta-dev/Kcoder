import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { darkColors, lightColors } from "@/theme";
import { createTerminalTheme } from "./terminal-theme";
import { TerminalCommandQueue } from "./terminal-command-queue";
import { TerminalWebViewOptionsSync } from "./terminal-webview-options";

const lightAnsiColors = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function relativeLuminance(color: string): number {
  const channels = color.match(/[\da-f]{2}/gi)?.map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (!channels || channels.length !== 3) throw new Error(`Expected a hex color, got ${color}`);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("terminal themes", () => {
  it("uses the resolved light and dark palettes", () => {
    const light = createTerminalTheme("light", lightColors);
    const dark = createTerminalTheme("dark", darkColors);

    expect(light.background).toBe(lightColors.surface);
    expect(light.foreground).toBe(lightColors.text);
    expect(light.blue).toBe(lightColors.blue);
    expect(dark.background).toBe(darkColors.surface);
    expect(dark.foreground).toBe(darkColors.text);
    expect(dark.blue).not.toBe(light.blue);
  });

  it("keeps every light ANSI foreground at readable contrast while distinguishing bright variants", () => {
    const theme = createTerminalTheme("light", lightColors);

    for (const key of lightAnsiColors) {
      const foreground = theme[key];
      const background = theme.background;
      if (!foreground || !background) throw new Error(`Missing terminal color: ${key}`);
      expect(
        contrastRatio(foreground, background),
        `${key} should have at least 4.5:1 contrast against ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    for (const [normal, bright] of [
      ["black", "brightBlack"],
      ["red", "brightRed"],
      ["green", "brightGreen"],
      ["yellow", "brightYellow"],
      ["blue", "brightBlue"],
      ["magenta", "brightMagenta"],
      ["cyan", "brightCyan"],
      ["white", "brightWhite"],
    ] as const) {
      expect(theme[bright]).not.toBe(theme[normal]);
    }
  });

  it("replays the newest options at ready and preserves terminal data across theme updates", async () => {
    const dark = createTerminalTheme("dark", darkColors);
    const light = createTerminalTheme("light", lightColors);
    const optionsSync = new TerminalWebViewOptionsSync({
      scrollbackLines: 3_000,
      theme: dark,
    });
    optionsSync.setOptions({ scrollbackLines: 5_000, theme: light });
    expect(optionsSync.optionsChanged()).toBeNull();
    const readyOptions = optionsSync.rendererReady();
    expect(readyOptions).toEqual({
      type: "options",
      scrollbackLines: 5_000,
      theme: light,
    });

    const terminal = new Terminal();
    const queue = new TerminalCommandQueue();
    const applied: number[] = [];
    const write = (data: string, sequence: number) => new Promise<void>((resolve) => {
      queue.enqueue(terminal, { type: "write", data, sequence }, (appliedSequence) => {
        applied.push(appliedSequence);
        resolve();
      });
    });

    try {
      terminal.options.scrollback = readyOptions.scrollbackLines;
      terminal.options.theme = readyOptions.theme;
      await write("before", 1);

      optionsSync.setOptions({ scrollbackLines: 5_000, theme: dark });
      const themeUpdate = optionsSync.optionsChanged();
      expect(themeUpdate).toEqual({
        type: "options",
        scrollbackLines: 5_000,
        theme: dark,
      });
      if (themeUpdate) terminal.options.theme = themeUpdate.theme;
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("before");

      await write("+after", 2);
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("before+after");
      expect(applied).toEqual([1, 2]);

      optionsSync.rendererLoading();
      optionsSync.setOptions({ scrollbackLines: 7_000, theme: light });
      expect(optionsSync.optionsChanged()).toBeNull();
      const reloadedOptions = optionsSync.rendererReady();
      expect(reloadedOptions).toEqual({
        type: "options",
        scrollbackLines: 7_000,
        theme: light,
      });
      terminal.options.scrollback = reloadedOptions.scrollbackLines;
      terminal.options.theme = reloadedOptions.theme;
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("before+after");
    } finally {
      terminal.dispose();
    }
  });
});
