import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, test, vi } from "vitest";
import { ComposerFloatingAnchor, ComposerFloatingLayer } from "./ComposerFloatingLayer";

vi.mock("react-native", () => ({ Platform: { OS: "android" }, View: "View", StyleSheet: { absoluteFill: { position: "absolute" } } }));
vi.mock("@/theme", () => ({ spacing: { sm: 8 } }));
vi.mock("./taskStyles", () => ({ useTaskAppearance: () => ({ styles: {
  composerFloatingControls: { position: "absolute" }, submissionRecoveryAnchor: { position: "relative" },
} }) }));

test("native controls use the panel hit-test bounds and fence stale anchor measurements", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const warning = vi.spyOn(console, "error").mockImplementation((...args) => {
    if (!String(args[0]).includes("react-test-renderer is deprecated")) throw new Error(args.map(String).join(" "));
  });
  const measured: Array<(x: number, y: number) => void> = [];
  const host = {};
  let renderer: ReactTestRenderer | undefined;
  const tree = (label: string | null) => <ComposerFloatingLayer>
    <ComposerFloatingAnchor floating controls={label ? <span data-label={label} /> : null}>
      <span data-label="composer" />
    </ComposerFloatingAnchor>
  </ComposerFloatingLayer>;
  try {
    await act(async () => { renderer = create(tree("old"), { createNodeMock: element =>
      (element.props as { testID?: string }).testID === "submission-recovery-anchor" ? {
        measureLayout: (relative: object, done: (x: number, y: number) => void) => {
          expect(relative).toBe(host); measured.push(done);
        },
      } : host,
    }); });
    await act(async () => {
      renderer!.root.findByProps({ testID: "composer-floating-host" }).props.onLayout({ nativeEvent: { layout: { height: 400 } } });
      renderer!.update(tree("current"));
    });
    await act(async () => { measured[0](0, 280); });
    expect(renderer!.root.findAllByProps({ "data-label": "old" })).toHaveLength(0);
    await act(async () => { measured.at(-1)!(0, 280); });
    const control = renderer!.root.findByProps({ "data-label": "current" });
    expect(control.parent?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ bottom: 120 })]));
    expect(renderer!.root.findByProps({ testID: "submission-recovery-anchor" }).findAllByProps({ "data-label": "current" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "data-label": "composer" })).toHaveLength(1);
    await act(async () => { renderer!.update(tree("updated")); });
    expect(renderer!.root.findByProps({ "data-label": "current" })).toBe(control);
    await act(async () => { measured.at(-1)!(0, 280); });
    expect(renderer!.root.findByProps({ "data-label": "updated" })).toBe(control);
    const late = measured.at(-1)!;
    await act(async () => { renderer!.update(tree(null)); });
    await act(async () => { late(0, 200); });
    expect(renderer!.root.findAllByProps({ "data-label": "updated" })).toHaveLength(0);
  } finally {
    await act(async () => { renderer?.unmount(); });
    warning.mockRestore();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
