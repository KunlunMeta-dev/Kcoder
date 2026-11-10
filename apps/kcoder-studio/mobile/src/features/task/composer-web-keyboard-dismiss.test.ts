import { afterEach, expect, test, vi } from "vitest";
import { subscribeComposerWebKeyboardDismiss } from "./composer-web-keyboard-dismiss";

afterEach(() => vi.unstubAllGlobals());

function setup(touch = true) {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, scale: 1 });
  vi.stubGlobal("window", { visualViewport: viewport, matchMedia: () => ({ matches: touch }) });
  vi.stubGlobal("navigator", { maxTouchPoints: touch ? 1 : 0 });
  const focused = { value: true }, dismiss = vi.fn();
  const stop = subscribeComposerWebKeyboardDismiss(() => focused.value, dismiss);
  const resize = (height: number, width = 390, scale = 1) => {
    Object.assign(viewport, { height, width, scale });
    viewport.dispatchEvent(new Event("resize"));
  };
  return { focused, dismiss, stop, resize };
}

test("a touch viewport restores after a keyboard-sized reduction, once, while the input retains focus", () => {
  const { resize, dismiss, stop } = setup();
  resize(420); expect(dismiss).not.toHaveBeenCalled();
  resize(844); expect(dismiss).toHaveBeenCalledTimes(1);
  resize(844); expect(dismiss).toHaveBeenCalledTimes(1);
  stop(); resize(420); resize(844); expect(dismiss).toHaveBeenCalledTimes(1);
});

test("toolbar-sized viewport changes, desktop resizing and unfocused inputs do not trigger keyboard dismissal", () => {
  const touch = setup(); touch.resize(790); touch.resize(844); expect(touch.dismiss).not.toHaveBeenCalled();
  touch.focused.value = false; touch.resize(420); touch.resize(844); expect(touch.dismiss).not.toHaveBeenCalled(); touch.stop();
  const desktop = setup(false); desktop.resize(420); desktop.resize(844); expect(desktop.dismiss).not.toHaveBeenCalled();
});

test("rotation and pinch zoom reset keyboard observations", () => {
  const { resize, dismiss } = setup();
  resize(420); resize(390, 844); resize(844); expect(dismiss).not.toHaveBeenCalled();
  resize(420); resize(420, 390, 2); resize(844); expect(dismiss).not.toHaveBeenCalled();
});

test("server rendering has no browser listeners", () => {
  vi.stubGlobal("window", undefined);
  expect(() => subscribeComposerWebKeyboardDismiss(() => true, vi.fn())()).not.toThrow();
});
