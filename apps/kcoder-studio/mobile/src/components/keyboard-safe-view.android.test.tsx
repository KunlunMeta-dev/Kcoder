import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { KeyboardGeometry } from "./keyboard-geometry-state";
const host = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as Array<{ current: unknown }>, stateIndex: 0, refIndex: 0,
  effectMounted: false, cleanup: undefined as (() => void) | undefined, metrics: undefined as { height: number } | undefined,
  listeners: new Map<string, () => void>(), removed: 0 }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = host.stateIndex++;
    if (!(index in host.states)) host.states[index] = typeof initial === "function" ? initial() : initial;
    return [host.states[index], (value: unknown) => { host.states[index] = value; }];
  },
  useRef: (initial: unknown) => host.refs[host.refIndex++] ??= { current: initial },
  useEffect: (effect: () => () => void) => { if (!host.effectMounted) { host.effectMounted = true; host.cleanup = effect(); } },
}));
vi.mock("expo-modules-core", () => ({ requireNativeViewManager: () => "NativeKeyboardGeometry" }));
vi.mock("react-native", () => ({ View: "View", KeyboardAvoidingView: "KeyboardAvoidingView", Keyboard: {
  metrics: () => host.metrics, isVisible: () => Boolean(host.metrics?.height),
  addListener: (name: string, listener: () => void) => { host.listeners.set(name, listener); return { remove() { host.removed++; host.listeners.delete(name); } }; },
} }));
import { KeyboardSafeView } from "./keyboard-safe-view.android";
function render(scope: "activity" | "modal" = "activity") {
  host.stateIndex = 0; host.refIndex = 0;
  return KeyboardSafeView({ scope, children: "composer", style: { flex: 1 } });
}
function padding(tree: ReactElement<Record<string, any>>) { return tree.props.children.props.style.paddingBottom; }
function event(tree: ReactElement<Record<string, any>>, values: Partial<KeyboardGeometry>) {
  tree.props.onGeometryChange({ nativeEvent: { generation: 10, sequence: 1, keyboardEpoch: 0, overlap: 300, imeVisible: true, source: "insets", ...values } });
}
beforeEach(() => { host.states = []; host.refs = []; host.effectMounted = false; host.cleanup = undefined; host.metrics = undefined; host.listeners.clear(); host.removed = 0; });
it("seeds an existing IME and applies overlap only to the unmeasured inner child", () => {
  host.metrics = { height: 300 };
  let tree = render(); expect(tree.props.legacyKeyboardVisible).toBe(true);
  event(tree, {}); tree = render(); expect(padding(tree)).toBe(300);
  expect(tree.props.style).toEqual({ flex: 1 });
  event(tree, { sequence: 2, overlap: 0 }); tree = render(); expect(padding(tree)).toBe(0);
});
it("accepts replacement View attachments and rejects old queued geometry", () => {
  let tree = render(); event(tree, {}); tree = render();
  event(tree, { generation: 20, sequence: 1, overlap: 240 }); tree = render(); expect(padding(tree)).toBe(240);
  event(tree, { generation: 10, sequence: 99, overlap: 500 }); tree = render(); expect(padding(tree)).toBe(240);
  event(tree, { generation: 20, sequence: 2, source: "unknown", overlap: 999 }); tree = render(); expect(padding(tree)).toBe(0);
  event(tree, { generation: 20, sequence: 1, overlap: 240 }); expect(padding(render())).toBe(0);
});
it("tracks show/hide and ignores callbacks after cleanup", () => {
  let tree = render(); expect(tree.props.legacyKeyboardVisible).toBeNull();
  const show = host.listeners.get("keyboardDidShow")!;
  show(); tree = render(); expect(tree.props.legacyKeyboardVisible).toBe(true);
  event(tree, { keyboardEpoch: 1 }); host.listeners.get("keyboardDidHide")!();
  event(tree, { keyboardEpoch: 2, sequence: 2, overlap: 0, imeVisible: false }); tree = render();
  expect(tree.props.legacyKeyboardVisible).toBe(false); expect(padding(tree)).toBe(0);
  const before = [...host.states]; host.cleanup!();
  event(tree, { generation: 30, overlap: 400 }); show();
  expect(host.states).toEqual(before); expect(host.removed).toBe(2); expect(host.listeners.size).toBe(0);
});
it("clears on hide immediately and fences late positives until a new keyboard cycle", () => {
  let tree = render();
  host.listeners.get("keyboardDidShow")!(); tree = render();
  expect(tree.props.keyboardEpoch).toBe(1);
  event(tree, { keyboardEpoch: 1 }); tree = render(); expect(padding(tree)).toBe(300);
  const beforeHide = tree;
  host.listeners.get("keyboardDidHide")!();
  // The old callback may run before React commits the hidden props to the native View.
  event(beforeHide, { keyboardEpoch: 1, sequence: 99, overlap: 500 });
  tree = render(); expect(padding(tree)).toBe(0); expect(tree.props.keyboardEpoch).toBe(2);
  event(tree, { keyboardEpoch: 2, sequence: 100, overlap: 500 });
  expect(padding(render())).toBe(0);
  event(tree, { keyboardEpoch: 2, sequence: 101, overlap: 0, imeVisible: false });
  expect(padding(render())).toBe(0);
  host.listeners.get("keyboardDidShow")!(); tree = render();
  expect(tree.props.keyboardEpoch).toBe(3);
  event(tree, { keyboardEpoch: 2, sequence: 999, overlap: 500 });
  expect(padding(render())).toBe(0);
  event(tree, { keyboardEpoch: 3, sequence: 102, overlap: 240 });
  expect(padding(render())).toBe(240);
});
it("keeps Modal avoidance separate from Activity native geometry", () => {
  const tree = render("modal"); expect(tree.type).toBe("KeyboardAvoidingView");
  expect(tree.props.behavior).toBe("padding");
  host.listeners.get("keyboardDidHide")!(); expect(render("modal").props.enabled).toBe(false);
});
it("fails closed for invalid overlap values and malformed attachment identity", () => {
  let tree = render(); event(tree, {}); tree = render(); expect(padding(tree)).toBe(300);
  event(tree, { sequence: 2, overlap: Number.NaN }); tree = render(); expect(padding(tree)).toBe(0);
  event(tree, { sequence: 3, overlap: -40 }); tree = render(); expect(padding(tree)).toBe(0);
  event(tree, { sequence: 4, overlap: 500, imeVisible: false }); tree = render(); expect(padding(tree)).toBe(0);
  event(tree, { generation: Number.NaN, sequence: 5, overlap: 500 }); expect(padding(render())).toBe(0);
});
