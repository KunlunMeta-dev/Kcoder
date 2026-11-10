import { expect, it, vi } from "vitest";
const platform = vi.hoisted(() => ({ OS: "android" }));
vi.mock("react-native", () => ({ Platform: platform, View: "View", KeyboardAvoidingView: "KeyboardAvoidingView" }));
import { KeyboardSafeView } from "./keyboard-safe-view";
it.each(["android", "ios", "web"])("keeps %s avoidance with its host owner", os => {
  platform.OS = os;
  const rendered = KeyboardSafeView({ style: { flex: 1 } });
  expect(rendered.type).toBe(os === "android" ? "View" : "KeyboardAvoidingView");
  expect(rendered.props.behavior).toBe(os === "ios" ? "padding" : undefined);
  expect(rendered.props.style).toEqual({ flex: 1 });
});
