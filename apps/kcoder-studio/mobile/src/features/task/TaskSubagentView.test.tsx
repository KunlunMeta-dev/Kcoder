import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, test, vi } from "vitest";
import { TaskSubagentPanel, TaskSubagentTranscript } from "./TaskSubagentView";

vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal", Platform: { OS: "android" }, Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text",
  TextInput: "TextInput", View: "View", StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("lucide-react-native", () => Object.fromEntries(["ArrowLeft", "Bot", "ChevronRight", "Info", "MoreHorizontal", "RefreshCw", "History"].map(name => [name, name])));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/theme", () => ({ spacing: { sm: 8, md: 12 }, radius: { md: 8 }, useTheme: () => ({ colors: {} }) }));
vi.mock("@/features/interface/ConversationV3", () => ({ ConversationV3Background: () => null }));
vi.mock("./MessageBubble", () => ({ MessageBubble: "MessageBubble" }));
vi.mock("./TaskMenu", () => ({ TaskMenuSheet: "TaskMenuSheet" }));
vi.mock("./taskStyles", () => ({ useTaskAppearance: () => ({ styles: { taskMenuRow: {}, taskMenuText: {} } }) }));

test("the shared subagent header exposes refresh through More and retires menus on navigation", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const warning = vi.spyOn(console, "error").mockImplementation((...args) => {
    if (!String(args[0]).includes("react-test-renderer is deprecated")) throw new Error(args.map(String).join(" "));
  });
  const onRefresh = vi.fn(), onBack = vi.fn();
  let renderer: ReactTestRenderer | undefined;
  const tree = (refreshDisabled = false, title?: string, visible = true) => <TaskSubagentPanel
    visible={visible} title={title} onBack={onBack} onRefresh={onRefresh} refreshDisabled={refreshDisabled} bottomInset={0}>
    <span>Public agent transcript</span>
  </TaskSubagentPanel>;
  try {
    await act(async () => { renderer = create(tree()); });
    const button = (id: string) => renderer!.root.findAll(node => String(node.type) === "Pressable" && node.props.testID === id)[0];
    const menu = () => renderer!.root.findAll(node => String(node.type) === "TaskMenuSheet")[0];
    expect(menu().props.visible).toBe(false);
    await act(async () => { button("mobile-subagent-more").props.onPress(); });
    expect(menu().props.visible).toBe(true);
    expect(onRefresh).not.toHaveBeenCalled();
    await act(async () => { button("mobile-subagent-refresh").props.onPress(); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(menu().props.visible).toBe(false);
    await act(async () => { renderer!.update(tree(true)); });
    await act(async () => { button("mobile-subagent-more").props.onPress(); });
    expect(menu().props.visible).toBe(true);
    expect(button("mobile-subagent-refresh").props.disabled).toBe(true);
    expect(button("mobile-subagent-refresh").props.accessibilityState.disabled).toBe(true);
    await act(async () => { menu().props.onClose(); });
    expect(menu().props.visible).toBe(false);
    await act(async () => { button("mobile-subagent-more").props.onPress(); });
    await act(async () => { renderer!.update(tree(false, "Another agent")); });
    expect(menu().props.visible).toBe(false);
    await act(async () => { button("mobile-subagent-more").props.onPress(); });
    await act(async () => { renderer!.update(tree(false, "Another agent", false)); });
    await act(async () => { renderer!.update(tree(false, "Another agent")); });
    expect(menu().props.visible).toBe(false);
    expect(onBack).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => { renderer?.unmount(); });
    warning.mockRestore();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

test("task information is opened from More, stays selectable and retires when agent identity changes", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const warning = vi.spyOn(console, "error").mockImplementation((...args) => {
    if (!String(args[0]).includes("react-test-renderer is deprecated")) throw new Error(args.map(String).join(" "));
  });
  let renderer: ReactTestRenderer | undefined;
  const tree = (id: string | null) => <TaskSubagentPanel visible onBack={vi.fn()} onRefresh={vi.fn()}
    refreshDisabled={false} bottomInset={0} title="Same name"
    information={id ? { agentId: id, directory: "/workspace/project", goal: "Check the layout" } : undefined}>
    <TaskSubagentTranscript agent={{ agentId: id || "worker", status: "completed", acceptingMessages: false, queueDepth: 0 }}
      page={{ threadId: "parent", agentId: id || "worker", content: "Public answer" }} parentTitle="Parent"
      targetLabel="Server" directory="/workspace/project" onParent={vi.fn()} />
  </TaskSubagentPanel>;
  try {
    await act(async () => { renderer = create(tree("first")); });
    const button = (id: string) => renderer!.root.findAll(node => String(node.type) === "Pressable" && node.props.testID === id)[0];
    const menu = () => renderer!.root.findAll(node => String(node.type) === "TaskMenuSheet")[0];
    expect(renderer!.root.findAll(node => String(node.type) === "Text" && node.props.children === "task.view_technical_details")).toHaveLength(0);
    await act(async () => { button("mobile-subagent-more").props.onPress(); });
    await act(async () => { button("mobile-subagent-information-open").props.onPress(); });
    expect(menu().props.visible).toBe(true);
    expect(menu().props.testID).toBe("mobile-subagent-information");
    expect(menu().props.title).toBe("task.subagent_information");
    expect(renderer!.root.findAll(node => String(node.type) === "Text" && node.props.selectable).map(node => node.props.children))
      .toEqual(["Check the layout", "/workspace/project"]);
    await act(async () => { menu().props.onClose(); });
    await act(async () => { button("mobile-subagent-more").props.onPress(); });
    expect(menu().props.testID).toBe("mobile-subagent-menu");
    await act(async () => { button("mobile-subagent-information-open").props.onPress(); });
    await act(async () => { renderer!.update(tree("second")); });
    expect(menu().props.visible).toBe(false);
    expect(menu().props.testID).toBe("mobile-subagent-menu");
    await act(async () => { renderer!.update(tree(null)); });
    await act(async () => { button("mobile-subagent-more").props.onPress(); });
    expect(button("mobile-subagent-information-open")).toBeUndefined();
  } finally {
    await act(async () => { renderer?.unmount(); });
    warning.mockRestore();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
