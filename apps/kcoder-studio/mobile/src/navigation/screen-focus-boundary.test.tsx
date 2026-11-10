import React from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ focused: true }));
vi.mock("expo-router", () => ({ useIsFocused: () => state.focused }));
import { ScreenFocusBoundary } from "./screen-focus-boundary.web";
import { ScreenFocusBoundary as NativeBoundary } from "./screen-focus-boundary";

it("makes retained Web pages inert when blurred and restores interaction on return without remounting their content", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let mounts = 0;
  function Content() { React.useEffect(() => { mounts++; }, []); return <input defaultValue="retained draft" />; }
  state.focused = true;
  const content = <ScreenFocusBoundary><Content /></ScreenFocusBoundary>;
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => { view = create(content); });
    const input = view.root.findByType("input");
    expect(view.root.findByType("div").props.inert).toBe(false);
    state.focused = false;
    await act(async () => { view.update(<ScreenFocusBoundary><Content /></ScreenFocusBoundary>); });
    expect(view.root.findByType("div").props.inert).toBe(true);
    state.focused = true;
    await act(async () => { view.update(<ScreenFocusBoundary><Content /></ScreenFocusBoundary>); });
    expect(view.root.findByType("div").props.inert).toBe(false);
    expect(view.root.findByType("input")).toBe(input);
    expect(mounts).toBe(1);
  } finally { await act(async () => view?.unmount()); vi.unstubAllGlobals(); }
});
it("leaves Native screen ownership to its navigator", () => {
  const child = <span>native content</span>;
  expect(NativeBoundary({ children: child })).toBe(child);
});

it("releases a retained control's focus during ref cleanup on blur, while ordinary rerenders preserve it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const doc: { activeElement: unknown } = { activeElement: null };
  class Active { blur = vi.fn(() => { doc.activeElement = null; }); }
  vi.stubGlobal("document", doc); vi.stubGlobal("HTMLElement", Active);
  const active = new Active(); doc.activeElement = active;
  const node = { contains: (value: unknown) => value === active };
  state.focused = true;
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => { view = create(<ScreenFocusBoundary><input /></ScreenFocusBoundary>, { createNodeMock: element => element.type === "div" ? node : null }); });
    await act(async () => { view.update(<ScreenFocusBoundary><input defaultValue="draft" /></ScreenFocusBoundary>); });
    expect(active.blur).not.toHaveBeenCalled();
    state.focused = false;
    await act(async () => { view.update(<ScreenFocusBoundary><input defaultValue="draft" /></ScreenFocusBoundary>); });
    expect(active.blur).toHaveBeenCalledOnce();
    expect(doc.activeElement).toBeNull();
  } finally { await act(async () => view?.unmount()); vi.unstubAllGlobals(); }
});
