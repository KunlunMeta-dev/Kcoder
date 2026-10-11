import { describe, expect, it } from "vitest";
import { editorScrollOffsetY } from "./editor-scroll";

describe("editor scroll offset", () => {
  it("reads the native React Native content offset", () => {
    expect(editorScrollOffsetY({ nativeEvent: { contentOffset: { y: 42 } } })).toBe(42);
  });

  it("reads a React Native Web textarea scrollTop without throwing", () => {
    expect(editorScrollOffsetY({ nativeEvent: {}, currentTarget: { scrollTop: 84 } })).toBe(84);
    expect(editorScrollOffsetY({ nativeEvent: { target: { scrollTop: 126 } } })).toBe(126);
    expect(editorScrollOffsetY({ nativeEvent: {} })).toBe(0);
  });
});
