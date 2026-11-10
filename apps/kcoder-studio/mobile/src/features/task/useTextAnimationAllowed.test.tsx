import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  Platform: { OS: "web" },
  AppState: { currentState: "active", addEventListener: vi.fn() },
  AccessibilityInfo: { addEventListener: vi.fn(), isReduceMotionEnabled: vi.fn() },
}));
vi.mock("react-native", () => native);
import { useTextAnimationAllowed } from "./useTextAnimationAllowed";

let view: ReactTestRenderer | undefined;
function Probe() { return <span>{String(useTextAnimationAllowed())}</span>; }
const allowed = () => view!.root.findByType("span").children.join("") === "true";
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); native.Platform.OS = "web"; });
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("flushes when the Web page hides or reduced motion changes and removes subscriptions", async () => {
  const documentEvents = new EventTarget(), media = new EventTarget();
  const doc = Object.assign(documentEvents, { visibilityState: "visible" });
  const query = Object.assign(media, { matches: false });
  const documentCleanup = vi.spyOn(doc, "removeEventListener"), mediaCleanup = vi.spyOn(query, "removeEventListener");
  vi.stubGlobal("document", doc); vi.stubGlobal("matchMedia", () => query);
  await act(async () => { view = create(<Probe />); }); expect(allowed()).toBe(true);
  await act(async () => { doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange")); });
  expect(allowed()).toBe(false);
  await act(async () => { doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); });
  expect(allowed()).toBe(true);
  await act(async () => { query.matches = true; query.dispatchEvent(new Event("change")); });
  expect(allowed()).toBe(false);
  await act(async () => { query.matches = false; query.dispatchEvent(new Event("change")); });
  expect(allowed()).toBe(true);
  await act(async () => view!.unmount()); view = undefined;
  expect(documentCleanup).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  expect(mediaCleanup).toHaveBeenCalledWith("change", expect.any(Function));
});

it("uses native activity and respects a live motion event over a late initial preference read", async () => {
  native.Platform.OS = "android";
  let activity!: (state: string) => void, motion!: (reduced: boolean) => void, resolve!: (value: boolean) => void;
  const applicationCleanup = vi.fn(), motionCleanup = vi.fn();
  native.AppState.addEventListener.mockImplementation((_event, listener) => { activity = listener; return { remove: applicationCleanup }; });
  native.AccessibilityInfo.addEventListener.mockImplementation((_event, listener) => { motion = listener; return { remove: motionCleanup }; });
  native.AccessibilityInfo.isReduceMotionEnabled.mockReturnValue(new Promise<boolean>(done => { resolve = done; }));
  await act(async () => { view = create(<Probe />); }); expect(allowed()).toBe(false);
  await act(async () => { motion(false); }); expect(allowed()).toBe(true);
  await act(async () => { activity("background"); }); expect(allowed()).toBe(false);
  await act(async () => { activity("active"); }); expect(allowed()).toBe(true);
  await act(async () => { motion(true); resolve(false); }); expect(allowed()).toBe(false);
  await act(async () => { motion(false); }); expect(allowed()).toBe(true);
  await act(async () => view!.unmount()); view = undefined;
  expect(applicationCleanup).toHaveBeenCalledOnce(); expect(motionCleanup).toHaveBeenCalledOnce();
});
