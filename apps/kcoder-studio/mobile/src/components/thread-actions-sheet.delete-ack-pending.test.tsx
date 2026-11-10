import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { zhCN } from "@/i18n/locales/zh-CN";
import { ThreadActionsSheet } from "./thread-actions-sheet";

const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  confirmation: vi.fn(),
  deleteStoredThread: vi.fn(),
  removeWorkspaceState: vi.fn(),
  onRemoved: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = harness.stateIndex++;
      if (!(index in harness.states)) harness.states[index] = initial;
      return [harness.states[index], (value: unknown) => { harness.states[index] = value; }];
    },
    useEffect: () => {},
    useCallback: (callback: unknown) => callback,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Platform: { OS: "web" },
  Pressable: "Pressable",
  StyleSheet: { absoluteFill: {}, create: (value: unknown) => value },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("lucide-react-native", () => Object.fromEntries(
  ["Archive", "ArchiveRestore", "Pencil", "Trash2", "X"].map((name) => [name, name]),
));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/runtime/task-runtime", () => ({
  deleteStoredThread: harness.deleteStoredThread,
  taskRuntimeRegistry: { getForTarget: vi.fn(() => undefined), remove: vi.fn() },
  updateThreadMetadata: vi.fn(),
}));
vi.mock("@/storage/workspace-preferences", () => ({
  loadWorkspaceState: vi.fn(async () => null),
  removeWorkspaceState: harness.removeWorkspaceState,
  workspaceStateAuthorizationScope: () => "scope",
}));
vi.mock("@/storage/workspace-attachment-paths", () => ({ workspaceAttachmentPathsForThreadDeletion: () => [] }));
vi.mock("@/platform/confirmation", () => ({ requestConfirmation: harness.confirmation }));
vi.mock("@/theme", () => {
  const colors = new Proxy({}, { get: () => "color" });
  return {
    radius: { md: 8, lg: 12 },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16 },
    useTheme: () => ({ colors }),
    useThemedStyles: (factory: (value: unknown) => unknown) => factory(colors),
  };
});
vi.mock("./use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("./thread-actions-policy", () => ({
  matchesLiveTaskTarget: () => false,
  threadCanBeArchivedOrDeleted: () => true,
}));

function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}

function renderSheet() {
  harness.stateIndex = 0;
  return ThreadActionsSheet({
    visible: true,
    profile: { id: "gateway", baseUrl: "http://localhost" } as never,
    target: {
      server: { id: "server", label: "Server", workspacePath: "/workspace" } as never,
      thread: { id: "thread", title: "Task", cwd: "/workspace", status: "idle" } as never,
    },
    onClose: vi.fn(),
    onRenamed: vi.fn(),
    onRemoved: harness.onRemoved,
  });
}

beforeEach(() => {
  harness.states = [];
  harness.stateIndex = 0;
  harness.confirmation.mockReset();
  harness.deleteStoredThread.mockReset();
  harness.removeWorkspaceState.mockReset();
  harness.onRemoved = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

it("shows the inactive-thread ACK-pending error and skips local removal/success callback", async () => {
  const message = zhCN["task.remote_delete_ack_cleanup_pending"];
  harness.deleteStoredThread.mockRejectedValueOnce(new Error(message));

  let tree = renderSheet();
  const deleteButton = elements(tree).find((element) => element.props.testID === "thread-delete-action");
  (deleteButton?.props.onPress as (() => void) | undefined)?.();
  const confirmation = harness.confirmation.mock.calls[0]?.[0] as { onConfirm(): void } | undefined;
  expect(confirmation).toBeDefined();
  confirmation?.onConfirm();
  for (let index = 0; index < 8; index += 1) await Promise.resolve();

  tree = renderSheet();
  expect(elements(tree).some((element) => element.props.accessibilityRole === "alert" && element.props.children === message)).toBe(true);
  expect(harness.removeWorkspaceState).not.toHaveBeenCalled();
  expect(harness.onRemoved).not.toHaveBeenCalled();
});
