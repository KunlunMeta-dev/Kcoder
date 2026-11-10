import { beforeEach, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({ visible: false, state: undefined as boolean | undefined,
  listeners: new Map<string, () => void>(), cleanup: undefined as (() => void) | undefined, removed: 0 }));
vi.mock("react", () => ({
  useState: (initial: () => boolean) => {
    host.state ??= initial();
    return [host.state, (value: boolean) => { host.state = value; }];
  },
  useEffect: (effect: () => () => void) => { host.cleanup = effect(); },
}));
vi.mock("react-native", () => ({ Keyboard: {
  isVisible: () => host.visible,
  addListener: (name: string, listener: () => void) => {
    host.listeners.set(name, listener);
    return { remove: () => { host.removed++; host.listeners.delete(name); } };
  },
} }));
import { composerBottomPadding, useKeyboardVisible } from "./use-keyboard-visible";
beforeEach(() => { host.visible = false; host.state = undefined; host.listeners.clear(); host.removed = 0; });
it("removes Android navigation padding only while the IME owns the bottom edge", () => {
  expect(composerBottomPadding("android", true, 34, 8)).toBe(8);
  expect(composerBottomPadding("android", false, 34, 8)).toBe(34);
  expect(composerBottomPadding("ios", true, 34, 8)).toBe(34);
  expect(composerBottomPadding("web", false, 0, 8)).toBe(8);
});
it("seeds mounted-visible state and removes both owned listeners on unmount", () => {
  host.visible = true; expect(useKeyboardVisible()).toBe(true);
  host.listeners.get("keyboardDidHide")!(); expect(host.state).toBe(false);
  host.listeners.get("keyboardDidShow")!(); expect(host.state).toBe(true);
  host.cleanup!(); expect(host.removed).toBe(2); expect(host.listeners.size).toBe(0);
});
