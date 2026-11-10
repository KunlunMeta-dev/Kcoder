vi.mock("@/storage/interface-version", () => ({ useInterfaceVersion: () => "modern" }));
vi.mock("@/features/interface/ConversationV3", () => ({ ConversationV3Background: () => null, ConversationV3WelcomeMark: () => null, ConversationV3Header: "ConversationV3Header" }));
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, test, vi } from "vitest";
import { NewTaskDraft } from "./NewTaskDraft";
import { DraftContextBar, resolveDraftContextProjects, type DraftContextActual, type DraftContextStatus } from "./DraftContextBar";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Modal: "Modal",
  Platform: { OS: "web" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("./TaskAttachments", () => ({ DraftAttachmentSelectionSheet: () => null, LocalDraftAttachmentPreview: () => null }));
vi.mock("./TaskPermissionSelector", () => ({ TaskPermissionSheet: "TaskPermissionSheet", PermissionModeIcon: "PermissionModeIcon", PermissionOverrideMarker: "PermissionOverrideMarker" }));
vi.mock("./TaskComposer", () => ({ TaskComposer: ({ toolbar }: { toolbar?: React.ReactNode }) => <>{toolbar}</>, ComposerMetaRow: ({ permissionSelector, modelSelector, status }: any) => <>{permissionSelector}{modelSelector}{status}</> }));
vi.mock("./taskStyles", () => ({
  useTaskAppearance: () => ({
    colors: { textDim: "#777", textMuted: "#777", text: "#111" },
    styles: {
      panel: {}, messageListStage: {}, loadingWorkspaceLabel: {}, queueMeta: {}, composerWrap: {},
      composerMeta: {}, modelSelectorMeta: {}, model: {}, attachButton: {}, permissionTrigger: {}, permissionTriggerLabel: {},
    },
  }),
}));
vi.mock("@/components/ui", () => ({ Button: "Button", StatusDot: "StatusDot" }));
vi.mock("@/components/use-keyboard-visible", () => ({ useKeyboardVisible: () => false, composerBottomPadding: () => 0 }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@/storage/new-workspace-preferences", () => ({ reasoningEffortLabel: (value: string) => value }));
vi.mock("@/theme", () => {
  const colors = {
    text: "#111", textDim: "#777", textMuted: "#777", surfaceHover: "#eee", surfaceRaised: "#fff",
    overlay: "#0008", border: "#ccc", blue: "#06f",
  };
  return {
    radius: { chatComposer: 20, lg: 12, xl: 16, md: 8 },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16 },
    useTheme: () => ({ colors }),
    useThemedStyles: (factory: (value: typeof colors) => unknown) => factory(colors),
  };
});
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("lucide-react-native", () => ({
  Ban: "Icon", Monitor: "Icon", Server: "Icon", ChevronDown: "Icon", Check: "Icon", Folder: "Icon", RefreshCw: "Icon", SlidersHorizontal: "Icon", X: "Icon",
}));

function draft(actual: DraftContextActual, onSelectWorkspace = vi.fn(), options: { contextLocked?: boolean; ready?: boolean; busy?: boolean } = {}) {
  return <NewTaskDraft cwd={actual.cwd} input="unsent draft" setInput={vi.fn()} ready={options.ready ?? true} busy={options.busy ?? false}
    modelLabel="Model" reasoningEffort="" bottomInset={0} modelPickerOpen={false}
    openModelPicker={vi.fn()} submit={vi.fn(async () => {})} contextActual={actual} onSelectWorkspace={onSelectWorkspace}
    contextWorkspaces={[
      { serverId: "target-a", serverLabel: "Target A", path: "/workspace/a", label: "fixture-project" },
      { serverId: "target-a", serverLabel: "Target A", path: "/workspace/b", label: "Other project" },
      { serverId: "target-b", serverLabel: "Target B", path: "/workspace/a", label: "Same path on B" },
    ]}
    contextDefaultWorkspacePath="/workspace/default" contextWorkspacesReady contextLocked={options.contextLocked} />;
}

function current(scopeToken: object, serverId = "target-a", cwd = "/workspace/a", connectionStatus: DraftContextStatus = "online"): DraftContextActual {
  return {
    scopeToken, profileId: "gateway-a", serverId, serverLabel: serverId === "target-b" ? "Target B" : "Target A",
    cwd, projectLabel: "fixture-project", connectionStatus,
  };
}

const projectOptionId = (serverId: string, path: string) => `draft-context-project-option-${encodeURIComponent(serverId)}-${encodeURIComponent(path)}`;

test("project selection calls the current route callback with an exact existing path", async () => {
  const ownerA = {};
  const actual = current(ownerA);
  const selectWorkspace = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(draft(actual, selectWorkspace)); });
  const node = (testID: string) => renderer.root.findByProps({ testID });

  expect(node("draft-context-project").props.accessibilityState.disabled).toBe(false);
  expect(node("draft-context-status").props.accessibilityLabel).toBe("settings.status_online");
  expect(node("draft-context-project-name").children.join("")).toBe("fixture-project");
  await act(async () => { node("draft-context-project").props.onPress(); });
  expect(node("draft-context-project-modal").props.visible).toBe(true);
  expect(node(projectOptionId("target-a", "/workspace/default"))).toBeTruthy();
  expect(node(projectOptionId("target-a", "/workspace/a"))).toBeTruthy();
  expect(renderer.root.findAllByProps({ testID: projectOptionId("target-b", "/workspace/a") })).toHaveLength(0);
  await act(async () => { node("draft-context-close").props.onPress(); node("draft-context-server").props.onPress(); });
  await act(async () => { node("draft-context-server-option-target-a").props.onPress(); });
  expect(selectWorkspace).not.toHaveBeenCalled();
  await act(async () => { node("draft-context-server").props.onPress(); });
  await act(async () => { node("draft-context-server-option-target-b").props.onPress(); });
  expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith({ serverId: "target-b", path: "/workspace/a" });
  expect(node("draft-context-project-modal").props.visible).toBe(false);
  await act(async () => { renderer.unmount(); });
});

test("picker and stale workspace callbacks do not revive across owner A-B-A or cwd changes", async () => {
  const ownerA = {};
  const ownerB = {};
  const ownerAReturned = {};
  const ownerACwdChanged = {};
  const selectWorkspace = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(draft(current(ownerA), selectWorkspace)); });
  const node = (testID: string) => renderer.root.findByProps({ testID });
  await act(async () => { node("draft-context-project").props.onPress(); });
  const staleOptionPress = node(projectOptionId("target-a", "/workspace/b")).props.onPress;

  await act(async () => { renderer.update(draft(current(ownerB, "target-b", "/workspace/b"), selectWorkspace)); });
  expect(node("draft-context-project-modal").props.visible).toBe(false);
  await act(async () => { staleOptionPress(); });
  expect(selectWorkspace).not.toHaveBeenCalled();

  await act(async () => { node("draft-context-project").props.onPress(); });
  expect(node("draft-context-project-modal").props.visible).toBe(true);
  await act(async () => { renderer.update(draft(current(ownerAReturned), selectWorkspace)); });
  expect(node("draft-context-project-modal").props.visible).toBe(false);
  await act(async () => { node("draft-context-project").props.onPress(); });
  await act(async () => { renderer.update(draft(current(ownerACwdChanged, "target-a", "/workspace/b"), selectWorkspace)); });
  expect(node("draft-context-project-modal").props.visible).toBe(false);
  expect(node("draft-context-project-name").children.join("")).toBe("Other project");

  await act(async () => { renderer.update(draft(current(ownerACwdChanged, "target-a", "/workspace/b"), selectWorkspace, { contextLocked: true })); });
  expect(node("draft-context-project").props.disabled).toBe(true);
  expect(node("draft-context-project-modal").props.visible).toBe(false);
  await act(async () => { renderer.unmount(); });
});

test("first-turn permission selection uses the real sheet and fences stale owners", async () => {
  const ownerA = {}; const select = vi.fn();
  const render = (actual: DraftContextActual, busy = false) => React.cloneElement(draft(actual, vi.fn(), { busy }), { permissionsSupported: true, onSelectPermission: select });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(render(current(ownerA))); });
  const node = (testID: string) => renderer.root.findByProps({ testID });
  const sheet = () => renderer.root.findByType("TaskPermissionSheet" as any);
  await act(async () => { node("draft-permission-selector").props.onPress(); });
  expect(sheet().props).toMatchObject({ visible: true, selected: "default", supported: true, subtitle: "new.draft_permission_first_turn" });
  await act(async () => { sheet().props.onSelect("ask"); });
  expect(select).toHaveBeenCalledWith("ask"); expect(sheet().props.visible).toBe(false);
  await act(async () => { node("draft-permission-selector").props.onPress(); });
  const staleSelect = sheet().props.onSelect;
  await act(async () => { renderer.update(render(current({}, "target-a", "/workspace/a", "offline"))); });
  expect(sheet().props.visible).toBe(false);
  await act(async () => { staleSelect("yolo"); });
  expect(select).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByProps({ testID: "draft-permission-selector" })).toHaveLength(0);
  await act(async () => { renderer.unmount(); });
});

test("busy creation closes the permission sheet and disables selection", async () => {
  const ownerA = {}; let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(draft(current(ownerA))); });
  await act(async () => { renderer.root.findByProps({ testID: "draft-permission-selector" }).props.onPress(); });
  expect(renderer.root.findByType("TaskPermissionSheet" as any).props.visible).toBe(true);
  await act(async () => { renderer.update(draft(current(ownerA), vi.fn(), { busy: true })); });
  expect(renderer.root.findByType("TaskPermissionSheet" as any).props.visible).toBe(false);
  expect(renderer.root.findAllByProps({ testID: "draft-permission-selector" })).toHaveLength(0);
  await act(async () => { renderer.unmount(); });
});

test("project availability separates pending, empty and failed catalog reads", () => {
  const actual = current({}, "", "", "offline");
  expect(resolveDraftContextProjects(actual, [], false).availability).toBe("loading");
  expect(resolveDraftContextProjects(actual, [], true).availability).toBe("empty");
  expect(resolveDraftContextProjects(actual, [], false, undefined, "read failed").availability).toBe("failed");
});

test("connection retry invokes only the current owner once and stays disabled while pending", async () => {
  const ownerA = {}; const ownerB = {};
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  const retryA = vi.fn(() => pending); const retryB = vi.fn();
  const render = (scopeToken: object, onRetry: () => void | Promise<void>, busy = false) => React.cloneElement(draft(current(scopeToken)), { contextRetry: { busy, onRetry } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(render(ownerA, retryA)); });
  const button = () => renderer.root.findByProps({ testID: "new-task-gateway-retry" });
  const stalePress = button().props.onPress;
  await act(async () => { void stalePress(); void stalePress(); });
  expect(retryA).toHaveBeenCalledOnce();
  expect(button().props.disabled).toBe(true);
  await act(async () => { renderer.update(render(ownerB, retryB, true)); });
  await act(async () => { await button().props.onPress(); await stalePress(); });
  expect(retryB).not.toHaveBeenCalled();
  await act(async () => { renderer.update(render(ownerB, retryB)); });
  await act(async () => { await button().props.onPress(); });
  expect(retryB).toHaveBeenCalledOnce();
  await act(async () => { complete(); await pending; });
  expect(button().props.disabled).toBe(false);
  await act(async () => { renderer.unmount(); });
});

test("an offline project remains selected and the ordinary picker can switch to another project", async () => {
  const select = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<DraftContextBar actual={current({}, "target-a", "/workspace/a", "offline")}
    workspaces={[
      { serverId: "target-a", path: "/workspace/a", label: "Offline project", serverLabel: "Target A" },
      { serverId: "target-b", path: "/workspace/b", label: "Other project", serverLabel: "Target B" },
    ]} workspaceOptionsReady onSelectWorkspace={select} />); });
  const node = (testID: string) => renderer.root.findByProps({ testID });
  await act(async () => { node("draft-context-project").props.onPress(); });
  expect(node("draft-context-project-name").children.join("")).toBe("Offline project");
  const optionButton = (testID: string) => renderer.root.findAllByProps({ testID }).find(item => String(item.type) === "Pressable");
  expect(optionButton(projectOptionId("target-a", "/workspace/a"))?.props["aria-pressed"]).toBe(true);
  expect(optionButton(projectOptionId("target-b", "/workspace/b"))).toBeUndefined();
  await act(async () => { node("draft-context-close").props.onPress(); node("draft-context-server").props.onPress(); });
  await act(async () => { node("draft-context-server-option-target-b").props.onPress(); });
  expect(select).toHaveBeenCalledExactlyOnceWith({ serverId: "target-b", path: "/workspace/b" });
  await act(async () => { renderer.unmount(); });
});
