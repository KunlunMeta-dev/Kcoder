import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  subscribeTerminalModifierAppState,
  TerminalModifierLatch,
  TerminalVirtualKeyboard,
} from "./terminal-virtual-keyboard";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => number) =>
      getSnapshot(),
  };
});

vi.mock("@/theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/theme")>();
  return {
    ...actual,
    useThemedStyles: (factory: (colors: Record<string, string>) => unknown) =>
      factory({
        background: "#18181B", surface: "#202024", surfaceRaised: "#2B2B30",
        surfaceHover: "#27272A", surfaceSidebar: "#141416", border: "#34343B",
        borderAccent: "#414148", text: "#FAFAFA", textMuted: "#A1A1AA",
        textDim: "#85858F", accent: "#FAFAFA", accentBright: "#93C5FD",
        accentText: "#18181B", blue: "#6A9DE0", green: "#22C55E",
        yellow: "#F59E0B", red: "#C64F43", overlay: "rgba(0,0,0,0.72)",
      }),
  };
});

vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "zh-CN" }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

function keyboardButton(
  label: string,
  latch: TerminalModifierLatch,
  onInput: (data: string) => void,
): () => void {
  const root = TerminalVirtualKeyboard({
    latch,
    disabled: false,
    onInput,
    onPaste: () => {},
    onFocusKeyboard: () => {},
  });
  const scroll = root.props.children as React.ReactElement<{
    children?: React.ReactNode;
  }>;
  for (const child of React.Children.toArray(scroll.props.children)) {
    if (!React.isValidElement(child) || typeof child.type !== "function")
      continue;
    const renderKey = child.type as (props: unknown) => React.ReactElement;
    const button = renderKey(child.props) as React.ReactElement<{
      accessibilityLabel?: string;
      onPress?: () => void;
    }>;
    if (button.props.accessibilityLabel === label && button.props.onPress)
      return button.props.onPress;
  }
  throw new Error(`missing virtual terminal key: ${label}`);
}

describe("TerminalModifierLatch", () => {
  it("applies a sticky ctrl modifier once", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("ctrl");
    expect(latch.consume("c")).toBe("\u0003");
    expect(latch.consume("c")).toBe("c");
  });

  it("combines shift and alt for the next printable character", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("shift");
    latch.toggle("alt");
    expect(latch.consume("a")).toBe("\u001bA");
    expect(latch.has("shift")).toBe(false);
    expect(latch.has("alt")).toBe(false);
  });

  it("encodes modified arrow keys using xterm CSI modifiers", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("ctrl");
    latch.toggle("shift");
    expect(latch.consumeKey("up")).toBe("\u001b[1;6A");
    expect(latch.consumeKey("up")).toBe("\u001b[A");
  });

  it("allows a selected modifier to be toggled off", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("alt");
    latch.toggle("alt");
    expect(latch.consume("x")).toBe("x");
  });

  it("notifies the UI when xterm input consumes a modifier", () => {
    const latch = new TerminalModifierLatch();
    let notifications = 0;
    const unsubscribe = latch.subscribe(() => { notifications += 1; });
    latch.toggle("ctrl");
    expect(latch.consume("c")).toBe("\u0003");
    expect(latch.getSnapshot()).toBe(2);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it("matches terminal encodings for reverse tab and ctrl-space", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("shift");
    expect(latch.consumeKey("tab")).toBe("\u001b[Z");
    latch.toggle("ctrl");
    expect(latch.consumeKey("space")).toBe("\u0000");
  });

  it.each([
    ["2", "\u0000"],
    ["3", "\u001b"],
    ["/", "\u001f"],
    ["8", "\u007f"],
    ["?", "\u007f"],
  ])("encodes ctrl-%s using conventional terminal control bytes", (character, expected) => {
    const latch = new TerminalModifierLatch();
    latch.toggle("ctrl");
    expect(latch.consume(character)).toBe(expected);
  });

  it("prefixes alt-backspace but keeps enter portable", () => {
    const latch = new TerminalModifierLatch();
    latch.toggle("alt");
    expect(latch.consumeKey("backspace")).toBe("\u001b\u007f");
    latch.toggle("alt");
    expect(latch.consumeKey("enter")).toBe("\r");
    expect(latch.has("alt")).toBe(false);
  });

  it.each(["inactive", "background"])(
    "clears a real virtual-keyboard modifier subscription on %s before the next key",
    (state) => {
      const latch = new TerminalModifierLatch();
      const onInput = vi.fn();
      const listeners = new Set<(state: string) => void>();
      const onActive = vi.fn();
      const subscription = subscribeTerminalModifierAppState(
        latch,
        (listener) => {
          listeners.add(listener);
          return { remove: () => listeners.delete(listener) };
        },
        onActive,
      );

      keyboardButton("Ctrl", latch, onInput)();
      expect(latch.has("ctrl")).toBe(true);
      listeners.forEach((listener) => listener(state));
      keyboardButton("↑", latch, onInput)();

      expect(onInput).toHaveBeenCalledWith("\u001b[A");
      expect(latch.has("ctrl")).toBe(false);
      expect(onActive).not.toHaveBeenCalled();
      subscription.remove();
      expect(listeners.size).toBe(0);
    },
  );

  it("keeps the production AppState active callback for terminal refit", () => {
    const latch = new TerminalModifierLatch();
    const listeners = new Set<(state: string) => void>();
    const onActive = vi.fn();
    const subscription = subscribeTerminalModifierAppState(
      latch,
      (listener) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
      onActive,
    );
    listeners.forEach((listener) => listener("active"));
    expect(onActive).toHaveBeenCalledOnce();
    subscription.remove();
  });
});
