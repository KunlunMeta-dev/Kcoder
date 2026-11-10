import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { TaskRuntime } from "@/runtime/task-runtime";
import type { TaskSnapshot } from "@/runtime/task-runtime/types";
import { initLocale } from "@/i18n";
import { TaskPermissionSelector, TaskPermissionSheet } from "./TaskPermissionSelector";

const hookHarness = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as Array<() => unknown> }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((initial: unknown) => {
    const slot = hookHarness.cursor++;
    if (!(slot in hookHarness.slots)) hookHarness.slots[slot] = initial;
    return [
      hookHarness.slots[slot],
      (next: unknown) => {
        hookHarness.slots[slot] =
          typeof next === "function"
            ? (next as (value: unknown) => unknown)(hookHarness.slots[slot])
            : next;
      },
    ];
  }) as typeof actual.useState;
  const useRef = ((initial: unknown) => {
    const slot = hookHarness.cursor++;
    if (!(slot in hookHarness.slots)) hookHarness.slots[slot] = { current: initial };
    return hookHarness.slots[slot] as { current: unknown };
  }) as typeof actual.useRef;
  return {
    ...actual,
    useState,
    useRef,
    useEffect: ((effect: () => unknown) => { hookHarness.effects.push(effect); }) as typeof actual.useEffect,
    useCallback: ((callback: unknown) => callback) as typeof actual.useCallback,
  };
});

vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("./taskStyles", () => ({ useTaskAppearance: () => ({ styles: {}, colors: {} }) }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  return {
    ...actual,
    AppState: { addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 320, height: 720, scale: 1, fontScale: 1 }),
  };
});
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    ["Bot", "Check", "FilePenLine", "Flame", "RotateCcw", "Shield", "ShieldOff", "ShieldQuestion", "ShieldX", "SlidersHorizontal", "X"]
      .map((name) => [name, () => null]),
  ),
);

type Element = React.ReactElement<Record<string, unknown>>;

function* walkElements(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walkElements(child);
    return;
  }
  if (!React.isValidElement(node)) return;
  const element = node as Element;
  yield element;
  yield* walkElements(element.props.children);
}

function findTestElement(node: unknown, testID: string): Element | undefined {
  return [...walkElements(node)].find((element) => element.props.testID === testID);
}

beforeEach(() => {
  hookHarness.cursor = 0;
  hookHarness.slots = [];
  hookHarness.effects = [];
  initLocale("en");
});

test("demo opens a read-only permission preview and option actions never mutate the runtime", () => {
  const setPermissionMode = vi.fn();
  const presentationEvents: string[] = [];
  const onOpenChange = vi.fn((visible: boolean) =>
    presentationEvents.push(visible ? "open" : "close"),
  );
  const onTriggerPressIn = vi.fn(() => presentationEvents.push("press-in"));
  const runtime = {
    isDisposed: () => false,
    supportsTurnPermissions: () => true,
    setPermissionMode,
    getSnapshot: () => idle,
  } as unknown as TaskRuntime;
  const selectorProps = {
    task: runtime,
    snapshot: idle,
    demo: true,
    onTriggerPressIn,
    onOpenChange,
  };

  let selector = TaskPermissionSelector(selectorProps);
  const trigger = findTestElement(selector, "composer-permission-selector");
  expect(trigger).toBeDefined();
  expect(trigger?.props.disabled).toBe(false);
  expect(trigger?.props.accessibilityLabel).toContain("read-only preview");
  (trigger?.props.onPressIn as (() => void) | undefined)?.();
  expect(presentationEvents).toEqual(["press-in"]);
  (trigger?.props.onPress as (() => void) | undefined)?.();
  expect(onOpenChange).toHaveBeenCalledWith(true);
  expect(presentationEvents.slice(0, 2)).toEqual(["press-in", "open"]);

  hookHarness.cursor = 0;
  selector = TaskPermissionSelector(selectorProps);
  const sheet = [...walkElements(selector)].find((element) => element.type === TaskPermissionSheet);
  expect(sheet?.props).toMatchObject({ visible: true, supported: true, canChange: false, demo: true });

  const sheetProps = sheet?.props as Parameters<typeof TaskPermissionSheet>[0] | undefined;
  const optionsTree = sheetProps ? TaskPermissionSheet(sheetProps) : null;
  for (const mode of ["default", "ask", "auto", "accept_edits", "dont_ask", "bypass", "yolo"]) {
    const option = findTestElement(optionsTree, `permission-mode-${mode}`);
    expect(option?.props.disabled).toBe(true);
    (option?.props.onPress as (() => void) | undefined)?.();
  }
  expect(setPermissionMode).not.toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

const idle = {
  threadId: "demo-thread",
  activeTurnId: null,
  connected: true,
  running: false,
  continuationPending: null,
  interaction: null,
  configurationReady: true,
} as TaskSnapshot;

test("a menu request consumed offline cannot reopen permissions on reconnect or a different target", () => {
  let live = { ...idle, connected: false };
  const runtime = { isDisposed: () => false, supportsTurnPermissions: () => true, getSnapshot: () => live, setPermissionMode: vi.fn() } as unknown as TaskRuntime;
  const render = (request: object, serverId = "one") => {
    hookHarness.cursor = 0; hookHarness.effects = [];
    const tree = TaskPermissionSelector({ task: runtime, snapshot: live, demo: false, hideTrigger: true, openRequest: request,
      server: { id: serverId, label: serverId, description: "", runtime: "kcoder", transport: "local" } });
    hookHarness.effects.forEach(effect => effect());
    return tree;
  };
  const oldRequest = {};
  render(oldRequest);
  live = { ...idle };
  render(oldRequest);
  const sheet = (tree: unknown) => [...walkElements(tree)].find(element => element.type === TaskPermissionSheet);
  expect(sheet(render(oldRequest))?.props.visible).toBe(false);
  const newRequest = {};
  render(newRequest);
  expect(sheet(render(newRequest))?.props.visible).toBe(true);
  render(newRequest, "two");
  expect(sheet(render(newRequest, "two"))?.props.visible).toBe(false);
  expect(runtime.setPermissionMode).not.toHaveBeenCalled();
});
