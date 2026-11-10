import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { WorkspaceHistoryActionsSheet } from "./workspace-history-actions-sheet";
import type { ProjectWorkspaceThreadGroup } from "./thread-list-presentation";
import type { KCoderServer } from "@/gateway/types";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
vi.mock("react-native", () => ({
  KeyboardAvoidingView: "KeyboardAvoidingView", Modal: "Modal", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View", Platform: { OS: "web" },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFill: {} },
}));
vi.mock("lucide-react-native", () => ({ Pencil: "Pencil", Pin: "Pin", PinOff: "PinOff", RefreshCw: "RefreshCw", X: "X" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/theme", () => ({
  radius: { md: 8, settingsGroup: 20 }, spacing: { sm: 8, md: 12, lg: 16 },
  useTheme: () => ({ colors: {} }), useThemedStyles: (factory: (value: object) => unknown) => factory({}),
}));

const server = { id: "target" } as KCoderServer;
const workspace = { path: "/repo", identity: "workspace" } as ProjectWorkspaceThreadGroup;
const props = { server, workspace, workspaceLabel: "repo", workspaceAccessibleName: "repo · /repo · Target", targetLabel: "Target", workspaceIndex: 1, onClose: vi.fn(), onSelect: vi.fn() };

it("prefills and cancels project rename without a write, validates names, and retains a failed edit for explicit retry", async () => {
  let reject!: (error: Error) => void;
  const failed = new Promise<void>((_, fail) => { reject = fail; });
  const save = vi.fn().mockReturnValueOnce(failed).mockResolvedValue(undefined);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<WorkspaceHistoryActionsSheet {...props} projectRename={{ name: "Original", enabled: true, onSave: save }} />); });
  const node = (id: string) => renderer.root.findByProps({ testID: `rename-project-${id}-target-1` });
  const open = () => renderer.root.findByProps({ testID: "rename-project-target-1" }).props.onPress();
  await act(async () => { open(); });
  expect(node("name").props.value).toBe("Original");
  await act(async () => { node("name").props.onChangeText("Discarded"); node("cancel").props.onPress(); });
  expect(save).not.toHaveBeenCalled();
  await act(async () => { open(); });
  expect(node("name").props.value).toBe("Original");
  await act(async () => { node("name").props.onChangeText("   "); });
  expect(node("save").props.disabled).toBe(true);
  await act(async () => { node("name").props.onChangeText("中".repeat(86)); });
  expect(renderer.root.findByProps({ accessibilityRole: "alert" }).props.children).toBe("home.project_name_too_long");
  await act(async () => { node("name").props.onChangeText("  New name  "); });
  const press = node("save").props.onPress;
  await act(async () => { press(); press(); });
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith("New name");
  expect(node("save").props.accessibilityState.busy).toBe(true);
  await act(async () => { reject(new Error("synthetic failure")); });
  expect(node("name").props.value).toBe("  New name  ");
  expect(renderer.root.findByProps({ accessibilityRole: "alert" }).props.children).toBe("home.project_rename_failed");
  await act(async () => { node("save").props.onPress(); });
  expect(save).toHaveBeenCalledTimes(2);
  expect(renderer.root.findAllByProps({ accessibilityRole: "alert" })).toHaveLength(0);
  await act(async () => { renderer.unmount(); });
});

it("settles a rejected pin, blocks same-render double presses, and permits an explicit retry", async () => {
  let reject!: (error: Error) => void;
  const first = new Promise<void>((_, fail) => { reject = fail; });
  const toggle = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<WorkspaceHistoryActionsSheet {...props} projectPin={{ name: "Project", pinned: false, enabled: true, onToggle: toggle }} />); });
  const pin = () => renderer.root.findByProps({ testID: "pin-project-target-1" });
  const press = pin().props.onPress;
  await act(async () => { press(); press(); });
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(pin().props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  await act(async () => { reject(new Error("synthetic failure")); });
  expect(renderer.root.findByProps({ accessibilityRole: "alert" }).props.children).toBe("home.project_pin_failed");
  expect(pin().props.disabled).toBe(false);
  await act(async () => { pin().props.onPress(); });
  expect(toggle).toHaveBeenCalledTimes(2);
  expect(renderer.root.findAllByProps({ accessibilityRole: "alert" })).toHaveLength(0);
  expect(renderer.root.findByProps({ testID: "refresh-history-target-1" })).toBeDefined();
  await act(async () => { renderer.unmount(); });
});

it("keeps unavailable pins disabled and retains the existing menu when no pin contract is supplied", async () => {
  const toggle = vi.fn(async () => {});
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<WorkspaceHistoryActionsSheet {...props} projectPin={{ name: "Project", pinned: true, enabled: false, onToggle: toggle }} />); });
  const pin = renderer.root.findByProps({ testID: "pin-project-target-1" });
  expect(pin.props.disabled).toBe(true);
  await act(async () => { pin.props.onPress(); });
  expect(toggle).not.toHaveBeenCalled();
  await act(async () => { renderer.update(<WorkspaceHistoryActionsSheet {...props} />); });
  expect(renderer.root.findAllByProps({ testID: "pin-project-target-1" })).toHaveLength(0);
  expect(renderer.root.findByProps({ testID: "refresh-history-target-1" })).toBeDefined();
  await act(async () => { renderer.unmount(); });
});
