import { useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "@/theme";

export type TerminalModifier = "ctrl" | "shift" | "alt";
export type TerminalVirtualKey = "escape" | "tab" | "backspace" | "space" | "left" | "up" | "down" | "right" | "enter";

const BASIC_KEYS: Record<TerminalVirtualKey, string> = {
  escape: "\u001b",
  tab: "\t",
  backspace: "\u007f",
  space: " ",
  left: "\u001b[D",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  enter: "\r",
};

function modifierCode(active: ReadonlySet<TerminalModifier>): number {
  return 1 + (active.has("shift") ? 1 : 0) + (active.has("alt") ? 2 : 0) + (active.has("ctrl") ? 4 : 0);
}

function ctrlSymbolCode(character: string): string | null {
  switch (character) {
    case " ":
    case "@":
    case "2":
      return "\u0000";
    case "[":
    case "3":
      return "\u001b";
    case "\\":
    case "4":
      return "\u001c";
    case "]":
    case "5":
      return "\u001d";
    case "^":
    case "6":
      return "\u001e";
    case "_":
    case "/":
    case "7":
      return "\u001f";
    case "8":
    case "?":
      return "\u007f";
    default:
      return null;
  }
}

export class TerminalModifierLatch {
  private readonly active = new Set<TerminalModifier>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): number => this.revision;

  private emit(): void {
    this.revision += 1;
    this.listeners.forEach((listener) => listener());
  }

  has(modifier: TerminalModifier): boolean { return this.active.has(modifier); }

  toggle(modifier: TerminalModifier): void {
    if (this.active.has(modifier)) this.active.delete(modifier);
    else this.active.add(modifier);
    this.emit();
  }

  clear(): void {
    if (this.active.size === 0) return;
    this.active.clear();
    this.emit();
  }

  consume(data: string): string {
    if (this.active.size === 0 || !data) return data;
    let result = data;
    if (result.length === 1 && this.active.has("shift") && /[a-z]/i.test(result)) result = result.toUpperCase();
    if (result.length === 1 && this.active.has("ctrl")) {
      const symbolic = ctrlSymbolCode(result);
      if (symbolic !== null) result = symbolic;
      else {
        const upper = result.toUpperCase().charCodeAt(0);
        if (upper >= 65 && upper <= 90) result = String.fromCharCode(upper & 31);
      }
    }
    if (this.active.has("alt")) result = `\u001b${result}`;
    this.clear();
    return result;
  }

  consumeKey(key: TerminalVirtualKey): string {
    const code = modifierCode(this.active);
    const arrow = key === "left" ? "D" : key === "up" ? "A" : key === "down" ? "B" : key === "right" ? "C" : null;
    if (arrow && code > 1) {
      this.clear();
      return `\u001b[1;${code}${arrow}`;
    }
    if (key === "tab" && this.active.size === 1 && this.active.has("shift")) {
      this.clear();
      return "\u001b[Z";
    }
    if (key === "space" && this.active.has("ctrl")) {
      const alt = this.active.has("alt");
      this.clear();
      return `${alt ? "\u001b" : ""}\u0000`;
    }
    if (key === "enter") {
      this.clear();
      return BASIC_KEYS.enter;
    }
    return this.consume(BASIC_KEYS[key]);
  }
}

export function TerminalVirtualKeyboard({ latch, disabled, onInput, onPaste, onFocusKeyboard }: { latch: TerminalModifierLatch; disabled: boolean; onInput(data: string): void; onPaste(): void; onFocusKeyboard(): void }) {
  useSyncExternalStore(latch.subscribe, latch.getSnapshot, latch.getSnapshot);
  const toggle = (modifier: TerminalModifier) => latch.toggle(modifier);
  const send = (key: TerminalVirtualKey) => {
    onInput(latch.consumeKey(key));
  };
  return (
    <View style={styles.root}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.row}>
        <Key label="Ctrl" active={latch.has("ctrl")} disabled={disabled} onPress={() => toggle("ctrl")} />
        <Key label="Shift" active={latch.has("shift")} disabled={disabled} wide onPress={() => toggle("shift")} />
        <Key label="Alt" active={latch.has("alt")} disabled={disabled} onPress={() => toggle("alt")} />
        <Key label="Esc" disabled={disabled} onPress={() => send("escape")} />
        <Key label="Tab" disabled={disabled} onPress={() => send("tab")} />
        <Key label="↑" disabled={disabled} onPress={() => send("up")} />
        <Key label="↓" disabled={disabled} onPress={() => send("down")} />
        <Key label="←" disabled={disabled} onPress={() => send("left")} />
        <Key label="→" disabled={disabled} onPress={() => send("right")} />
        <Key label="⌫" disabled={disabled} onPress={() => send("backspace")} />
        <Key label="Enter" disabled={disabled} wide onPress={() => send("enter")} />
        <Key label="粘贴" disabled={disabled} wide onPress={onPaste} accessibilityLabel="粘贴剪贴板" />
        <Key label="⌨" disabled={false} onPress={onFocusKeyboard} accessibilityLabel="打开系统键盘" />
      </ScrollView>
    </View>
  );
}

function Key({ label, active = false, disabled, wide = false, onPress, accessibilityLabel }: { label: string; active?: boolean; disabled: boolean; wide?: boolean; onPress(): void; accessibilityLabel?: string }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled, selected: active }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.key, wide && styles.wide, active && styles.active, disabled && styles.disabled, pressed && styles.pressed]}><Text style={[styles.keyText, active && styles.activeText]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 4, paddingVertical: 5, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surfaceSidebar },
  row: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 1 },
  key: { width: 48, height: 44, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.md, backgroundColor: colors.surfaceRaised },
  wide: { width: 62 },
  active: { borderColor: colors.accentBright, backgroundColor: colors.accent },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.72 },
  keyText: { color: colors.textMuted, fontSize: 10, fontWeight: "600" },
  activeText: { color: colors.text },
});
