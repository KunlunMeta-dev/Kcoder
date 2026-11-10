import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
import { useModalFocusTrap } from "./use-modal-focus-trap";

let doc: { activeElement: Element | null; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
class Element {
  isConnected = true;
  inactive = false;
  focus = vi.fn(() => { doc.activeElement = this; });
  closest = vi.fn(() => this.inactive ? this : null);
  setAttribute() {}
  getAttribute() { return null; }
  querySelectorAll() { return []; }
}
let view: ReactTestRenderer | undefined;
let surface: Element, trigger: Element;
function Probe({ visible, onClose = () => {}, escapeOnKeyUp = false }: { visible: boolean; onClose?(): void; escapeOnKeyUp?: boolean }) {
  const ref = useModalFocusTrap(visible, onClose, undefined, escapeOnKeyUp);
  ref.current = surface as never;
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("HTMLElement", Element);
  surface = new Element(); trigger = new Element();
  doc = { activeElement: trigger, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("document", doc);
});
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; vi.unstubAllGlobals(); });

it("restores focus to a still-active trigger and removes the owned key listener", async () => {
  await act(async () => { view = create(<Probe visible />); });
  expect(doc.activeElement).toBe(surface);
  await act(async () => { view!.update(<Probe visible={false} />); });
  expect(doc.activeElement).toBe(trigger);
  expect(doc.removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function), true);
});
it("does not restore focus into a retained inactive page when closing or changing routes", async () => {
  await act(async () => { view = create(<Probe visible />); });
  trigger.inactive = true;
  const destination = new Element(); doc.activeElement = destination;
  await act(async () => { view!.update(<Probe visible={false} />); });
  expect(trigger.focus).not.toHaveBeenCalled();
  expect(doc.activeElement).toBe(destination);
});

it("consumes Escape on keyup for detail navigation without also closing the native Web modal", async () => {
  const onClose = vi.fn();
  await act(async () => { view = create(<Probe visible onClose={onClose} escapeOnKeyUp />); });
  const keydown = doc.addEventListener.mock.calls.find(call => call[0] === "keydown")![1];
  const keyup = doc.addEventListener.mock.calls.find(call => call[0] === "keyup")![1];
  const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
  keydown(event);
  expect(onClose).not.toHaveBeenCalled();
  keyup(event);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(event.stopPropagation).toHaveBeenCalledTimes(2);
  await act(async () => { view!.update(<Probe visible={false} onClose={onClose} escapeOnKeyUp />); });
  expect(doc.removeEventListener).toHaveBeenCalledWith("keyup", keyup, true);
});
