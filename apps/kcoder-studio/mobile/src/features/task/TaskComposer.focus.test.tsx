// Exercise actual composer handlers in a deterministic hook host; no browser DOM.
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  platform: "web",
  interfaceVersion: "modern",
  effects: [] as Array<() => unknown>,
  keyboardListeners: new Map<string, () => void>(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      const index = host.cursor++;
      if (!(index in host.slots)) host.slots[index] = initial;
      return [host.slots[index], (next: unknown) => {
        host.slots[index] = typeof next === "function"
          ? (next as (current: unknown) => unknown)(host.slots[index])
          : next;
      }];
    },
    useRef(initial: unknown) {
      const index = host.cursor++;
      return host.slots[index] ??= { current: initial };
    },
    useEffect: (effect: () => unknown) => { host.effects.push(effect); },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});
vi.mock("react-native", () => ({
  Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove() {} }) },
  Platform: { get OS() { return host.platform; } },
  ActivityIndicator: "ActivityIndicator", Keyboard: { addListener: (name: string, callback: () => void) => {
    host.keyboardListeners.set(name, callback);
    return { remove() { host.keyboardListeners.delete(name); } };
  } }, Modal: "Modal",
  Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text",
  TextInput: "TextInput", View: "View",
}));
vi.mock("lucide-react-native", () => ({
  ArrowUp: "ArrowUp", Send: "Send", Paperclip: "Paperclip", Plus: "Plus", Sparkles: "Sparkles", Square: "Square", X: "X",
  ChevronDown: "ChevronDown", SlidersHorizontal: "SlidersHorizontal",
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("./taskStyles", () => ({ useTaskAppearance: () => ({ styles: {}, colors: {} }) }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("./TaskAttachments", () => ({
  ComposerAttachmentPreview: "ComposerAttachmentPreview", StagedAttachmentChip: "StagedAttachmentChip",
}));
vi.mock("@/storage/app-preferences", () => ({
  subscribeAppPreferences: () => () => {},
  getAppPreferencesSnapshot: () => ({ quickPhrases: [], interfaceVersion: host.interfaceVersion }),
}));
vi.mock("@/components/use-keyboard-visible", () => ({ composerBottomPadding: () => 0 }));
vi.mock("@/theme", () => ({ spacing: { sm: 8 } }));

vi.mock("./TaskPermissionSelector", () => ({ PermissionModeIcon: "PermissionModeIcon" }));

import { CachedTaskComposer, ComposerField, TaskComposer } from "./TaskComposer";

type Element = React.ReactElement<Record<string, unknown>>;
function find(node: unknown, testID: string): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, testID);
      if (found) return found;
    }
  } else if (React.isValidElement(node)) {
    const element = node as Element;
    if (element.type === ComposerField)
      return find(ComposerField(element.props as React.ComponentProps<typeof ComposerField>), testID);
    return element.props.testID === testID ? element : find(element.props.children, testID);
  }
}

const model = {
  task: {}, retainedOutbox: { rows: [], error: null },
  snapshot: { connected: true, running: false }, input: "", attachments: [],
  messageInputRef: { current: { isFocused: () => false } },
  failedSubmissions: [], canSend: false, openAttachmentSheet: vi.fn(),
};
function render(variant: "conversation" | "draft" = "draft", input = "") {
  host.cursor = 0;
  return TaskComposer({ variant, model: { ...model, input } as never });
}
function renderCached(draft: string) {
  host.cursor = 0;
  return CachedTaskComposer({ draft, bottomInset: 0, offline: true });
}
function focus() {
  const tree = render();
  (find(tree, "message-input")!.props.onFocus as () => void)();
  return render();
}
function blurInput(tree: unknown, relatedTarget: unknown) {
  const event = { relatedTarget, currentTarget: { contains: (node: unknown) => node === toolbarButton } };
  (find(tree, "message-input")!.props.onBlur as ((event: unknown) => void) | undefined)?.(event);
  (find(tree, "message-input-root")!.props.onBlur as ((event: unknown) => void) | undefined)?.(event);
}
const toolbarButton = {};

beforeEach(() => { host.cursor = 0; host.slots = []; host.effects = []; host.keyboardListeners.clear(); host.platform = "web"; host.interfaceVersion = "modern"; });

test("an offline V3 draft accepts text while send and attachments stay disabled; live and cached sessions stay read only", () => {
  host.interfaceVersion = "v3";
  const offline = { ...model, snapshot: { connected: false, running: false }, input: "Offline question", canSend: false };
  const tree = TaskComposer({ variant: "draft", draftEditable: true, model: offline as never,
    localAttachments: { count: 0, disabled: true, preview: null, open: vi.fn() } });
  expect(find(tree, "message-input")!.props.editable).toBe(true);
  expect(find(tree, "send-message")!.props.disabled).toBe(true);
  expect(find(tree, "composer-attachment")!.props.disabled).toBe(true);
  expect(find(tree, "composer-quick-phrases")).toBeUndefined();
  host.cursor = 0;
  const live = TaskComposer({ variant: "conversation", draftEditable: true, model: offline as never });
  expect(find(live, "message-input")!.props.editable).toBe(false);
  expect(find(renderCached("Cached text"), "message-input")!.props.editable).toBe(false);
});

test("More opens quick phrases once and disconnect consumes stale requests without replay on reconnect", () => {
  const request = {};
  const renderRequest = (connected: boolean, token: object) => {
    host.cursor = 0;
    host.effects = [];
    const tree = TaskComposer({ model: { ...model, snapshot: { connected, running: false } } as never, quickPhrasesOpenRequest: token });
    host.effects.forEach(effect => effect());
    return tree;
  };
  renderRequest(true, request);
  expect(find(renderRequest(true, request), "quick-phrases-picker")!.props.visible).toBe(true);
  (find(renderRequest(true, request), "quick-phrases-picker")!.props.onRequestClose as () => void)();
  expect(find(renderRequest(true, request), "quick-phrases-picker")!.props.visible).toBe(false);
  const offlineRequest = {};
  renderRequest(false, offlineRequest);
  renderRequest(true, offlineRequest);
  expect(find(renderRequest(true, offlineRequest), "quick-phrases-picker")!.props.visible).toBe(false);
});

test("conversation focus preserves its draft without restoring the removed quick-phrase toolbar button", () => {
  const tree = render("conversation");
  (find(tree, "message-input")!.props.onFocus as () => void)();
  expect(find(render("conversation"), "composer-quick-phrases")).toBeUndefined();
});

function expanded(tree: unknown) {
  return (find(tree, "message-input-area")!.props.style as Array<unknown>).some(style =>
    style !== null && typeof style === "object" && "height" in style);
}

test("web focus transfer keeps the attachment target mounted and clickable", () => {
  let tree = focus();
  expect(expanded(tree)).toBe(true);
  blurInput(tree, toolbarButton);
  tree = render();
  expect(expanded(tree)).toBe(true);
  (find(tree, "composer-attachment")!.props.onPress as () => void)();
  expect(model.openAttachmentSheet).toHaveBeenCalled();
});

test("tabbing into the toolbar preserves expansion and leaving it collapses the empty input", () => {
  let tree = focus();
  blurInput(tree, toolbarButton);
  tree = render();
  expect(expanded(tree)).toBe(true);
  (find(tree, "message-input-root")!.props.onBlur as (event: unknown) => void)({
    relatedTarget: {}, currentTarget: { contains: () => false },
  });
  expect(expanded(render())).toBe(false);
});

test("native input blur collapses an empty composer", () => {
  host.platform = "android";
  const tree = focus();
  expect(expanded(tree)).toBe(true);
  blurInput(tree, null);
  expect(expanded(render())).toBe(false);
});

test.each(["web", "android"])("V3 %s keeps the full draft while previewing two lines and re-expanding on input press", platform => {
  host.platform = platform; host.interfaceVersion = "v3";
  const draft = "Long draft\n".repeat(20);
  let tree = render("conversation", draft);
  (find(tree, "message-input")!.props.onFocus as () => void)();
  (find(tree, "message-input")!.props.onContentSizeChange as (event: unknown) => void)({ nativeEvent: { contentSize: { height: 420 } } });
  const inputHeight = (tree: unknown) => (find(tree, "message-input")!.props.style as Array<unknown>).find(style =>
    style !== null && typeof style === "object" && "height" in style);
  tree = render("conversation", draft);
  expect(inputHeight(tree)).toEqual({ height: 105 });
  expect(find(tree, "message-input")!.props.scrollEnabled).toBe(true);
  blurInput(tree, null);
  tree = render("conversation", draft);
  expect(inputHeight(tree)).toEqual({ height: 42 });
  expect(find(tree, "message-input")!.props.value).toBe(draft);
  expect(find(tree, "message-input")!.props.scrollEnabled).toBe(false);
  (find(tree, "message-input")!.props.onPressIn as () => void)();
  expect(inputHeight(render("conversation", draft))).toEqual({ height: 105 });
  if (platform === "android") {
    const focused = vi.spyOn(model.messageInputRef.current, "isFocused").mockReturnValue(true);
    try {
      host.effects.forEach(effect => effect());
      expect(inputHeight(render("conversation", draft))).toEqual({ height: 105 });
      host.keyboardListeners.get("keyboardDidHide")!();
      expect(inputHeight(render("conversation", draft))).toEqual({ height: 42 });
    } finally { focused.mockRestore(); }
  }
});

test("late cached draft hydration gets bounded multiline layout before TextInput measurement", () => {
  const draft = ["restored draft", "line two", "line three", "line four", "line five", "line six", "line seven"].join("\n");
  host.cursor = 0;
  host.slots = [];
  const initialTree = renderCached("");
  expect((find(initialTree, "message-input")!.props.scrollEnabled)).toBe(false);

  const restoredTree = renderCached(draft);
  const input = find(restoredTree, "message-input")!;
  expect(input.props.value).toBe(draft);
  expect(input.props.editable).toBe(false);
  expect(input.props.accessibilityState).toEqual({ disabled: true });
  expect(input.props.scrollEnabled).toBe(true);
  expect((input.props.style as unknown[]).find(style =>
    style !== null && typeof style === "object" && "height" in style,
  )).toEqual({ height: 105 });
});

test("classic quick phrases follow connection readiness and modern retains the More entry", () => {
  host.interfaceVersion = "classic";
  expect(find(focus(), "composer-quick-phrases")).toBeDefined();
  host.cursor = 0;
  expect(find(TaskComposer({ model: { ...model, snapshot: { connected: false } } as never }), "composer-quick-phrases")).toBeUndefined();
  host.interfaceVersion = "modern";
  expect(find(render(), "composer-quick-phrases")).toBeUndefined();
});
