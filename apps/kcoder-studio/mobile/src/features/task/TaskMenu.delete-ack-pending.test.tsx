import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskRuntime } from "@/runtime/task-runtime";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { TaskMenu } from "./TaskMenu";

const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  confirmation: vi.fn(),
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
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});
vi.mock("react-native", () => Object.fromEntries(
  ["ActivityIndicator", "Modal", "Pressable", "Text", "TextInput", "View"].map((name) => [name, name]),
));
vi.mock("lucide-react-native", () => Object.fromEntries(["Archive", "ArchiveRestore", "Bot", "ChevronLeft", "ChevronRight", "ListChecks", "Minimize2", "PanelsTopLeft", "Pencil", "Search", "Settings2", "Shield", "Sparkles", "Trash2", "X"].map(name => [name, name])));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/components/ui", () => ({ Button: "Button" }));
vi.mock("@/platform/confirmation", () => ({ requestConfirmation: harness.confirmation }));
vi.mock("./taskStyles", () => ({
  useTaskAppearance: () => ({
    colors: { textMuted: "muted" },
    styles: new Proxy({}, { get: () => "style" }),
  }),
}));

function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}

function renderMenu(task: TaskRuntime, onDeleted: () => void) {
  harness.stateIndex = 0;
  return TaskMenu({
    visible: true,
    task,
    demo: false,
    onClose: vi.fn(),
    onArchived: vi.fn(),
    onDeleted,
  });
}

function deferred<T>() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => { reject = rejectPromise; });
  return { promise, reject };
}

beforeEach(() => {
  harness.states = [];
  harness.stateIndex = 0;
  harness.confirmation.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("shows a confirmed-delete/local-ACK-pending error and skips success navigation", async () => {
  const message = zhCN["task.remote_delete_ack_cleanup_pending"];
  expect(en["task.remote_delete_ack_cleanup_pending"]).toContain("only while this app instance remains running");
  expect(en["task.remote_delete_ack_cleanup_pending"]).toContain("does not continue after a restart or in another tab");
  expect(message).toContain("仅在当前应用实例仍运行时");
  expect(message).toContain("不会跨重启或其他标签页延续");
  const deletion = deferred<void>();
  const task = {
    subscribe: () => () => {},
    getSnapshot: () => ({ title: "Task", running: false, archivedAt: null }),
    deleteThread: vi.fn(() => deletion.promise),
  } as unknown as TaskRuntime;
  const onDeleted = vi.fn();

  let tree = renderMenu(task, onDeleted);
  const managementButton = elements(tree).find((element) => element.props.testID === "task-menu-management");
  (managementButton?.props.onPress as (() => void) | undefined)?.();
  tree = renderMenu(task, onDeleted);
  const deleteButton = elements(tree).find((element) => element.props.testID === "delete-task");
  (deleteButton?.props.onPress as (() => void) | undefined)?.();
  const confirmation = harness.confirmation.mock.calls[0]?.[0] as { onConfirm(): void } | undefined;
  expect(confirmation).toBeDefined();
  confirmation?.onConfirm();
  deletion.reject(new Error(message));
  for (let index = 0; index < 6; index += 1) await Promise.resolve();

  tree = renderMenu(task, onDeleted);
  expect(elements(tree).some((element) => element.type === "Text" && element.props.children === message)).toBe(true);
  expect(onDeleted).not.toHaveBeenCalled();
});
