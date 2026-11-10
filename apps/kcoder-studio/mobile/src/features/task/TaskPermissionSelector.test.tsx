import React from "react";
import { createRequire } from "node:module";
import { expect, test, vi } from "vitest";
import { initLocale } from "@/i18n";
import { type TaskSnapshot } from "@/runtime/task-runtime/types";
import {
  canChangePermission,
  TaskPermissionSelector,
  TaskPermissionSheet,
} from "./TaskPermissionSelector";

const { renderToStaticMarkup } = createRequire(import.meta.url)(
  "react-dom/server",
) as { renderToStaticMarkup(element: React.ReactNode): string };

vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  const ReactRuntime = await import("react");
  return {
    ...actual,
    useWindowDimensions: () => ({ width: 390, height: 800, scale: 1, fontScale: 1 }),
    Modal: ({ visible, children, testID, accessibilityLabel }: { visible: boolean; children?: React.ReactNode; testID?: string; accessibilityLabel?: string }) =>
      visible
        ? ReactRuntime.createElement("div", { "data-testid": testID, "aria-label": accessibilityLabel }, children)
        : null,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    ["Bot", "Check", "FilePenLine", "Flame", "RotateCcw", "Shield", "ShieldOff", "ShieldQuestion", "ShieldX", "SlidersHorizontal", "X"]
      .map((name) => [name, () => null]),
  ),
);

const task = { isDisposed: () => false } as never;
const idle = {
  threadId: "thread-a",
  activeTurnId: null,
  connected: true,
  running: false,
  continuationPending: null,
  interaction: null,
  configurationReady: true,
} as TaskSnapshot;

test.each([
  ["connected", { connected: false }],
  ["running", { running: true }],
  ["active turn id", { activeTurnId: "turn-a" }],
  ["continuation", { continuationPending: "message-a" }],
  ["interaction", { interaction: { kind: "approval" } }],
  ["archived", { archivedAt: "2026-10-10T00:00:00Z" }],
  ["configuration", { configurationReady: false }],
  ["send acceptance unknown", { sendAcceptanceUnknown: true }],
  ["continuation unknown", { continuationUnknown: "message-a" }],
] as const)("permission changes are blocked for %s state", (_name, patch) => {
  expect(canChangePermission(task, { ...idle, ...patch } as TaskSnapshot)).toBe(false);
});

test.each([
  ["en", "Permissions", "Applies to future submissions; the current turn is unchanged.", "This server does not support per-turn permission choices.", "configured permission policy"],
  ["zh-CN", "权限模式", "用于后续发送，当前回合不受影响。", "当前服务端不支持按回合设置权限。", "使用目标配置的权限规则。"],
] as const)("%s permission sheet localizes scope and unsupported capability", (locale, title, scope, unavailable, defaultDescription) => {
  initLocale(locale);
  const html = renderToStaticMarkup(
    <TaskPermissionSheet
      visible
      supported={false}
      selected="default"
      canChange
      error={null}
      onClose={() => {}}
      onSelect={() => {}}
    />,
  );
  expect(html).toContain(title);
  expect(html).toContain(scope);
  expect(html).toContain(unavailable);
  expect(html).toContain(defaultDescription);
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain('data-testid="permission-mode-default"');
  expect(html).not.toContain('data-testid="permission-mode-ask"');
});

test.each([
  ["en", "Demo preview only. These choices do not represent target support and cannot change a real task."],
  ["zh-CN", "演示预览：这些选项仅供查看，不代表目标端支持情况，也不会修改真实任务。"],
] as const)("%s demo permission sheet is an explicit read-only preview", (locale, notice) => {
  initLocale(locale);
  const html = renderToStaticMarkup(
    <TaskPermissionSheet
      visible
      supported
      selected="default"
      canChange={false}
      demo
      error={null}
      onClose={() => {}}
      onSelect={() => {}}
    />,
  );
  expect(html).toContain(notice);
  expect(html).not.toContain("Applies to future submissions; the current turn is unchanged.");
  expect(html).not.toContain("用于后续发送，当前回合不受影响。");
  expect(html.match(/role="radio"/g)).toHaveLength(7);
  expect(html.match(/aria-disabled="true"/g)).toHaveLength(7);
});

test("supported permission sheet exposes seven checked states to web accessibility", () => {
  initLocale("en");
  const html = renderToStaticMarkup(
    <TaskPermissionSheet
      visible
      supported
      selected="accept_edits"
      canChange
      error={null}
      onClose={() => {}}
      onSelect={() => {}}
    />,
  );
  expect(html.match(/role="radio"/g)).toHaveLength(7);
  expect(html.match(/aria-checked="(?:true|false)"/g)).toHaveLength(7);
  expect(html).toContain('data-testid="permission-mode-accept_edits"');
  expect(html).toContain('data-testid="permission-mode-yolo"');
  expect(html).toMatch(/<div aria-checked="true"[^>]*data-testid="permission-mode-accept_edits"/);
});

test("composer trigger labels the selected mode and blocks edits during an active turn", () => {
  initLocale("en");
  const runtime = {
    isDisposed: () => false,
    supportsTurnPermissions: () => true,
    setPermissionMode: vi.fn(),
    getSnapshot: () => idle,
  };
  const html = renderToStaticMarkup(
    <TaskPermissionSelector
      task={runtime as never}
      snapshot={{ ...idle, permissionMode: "ask" } as TaskSnapshot}
      demo={false}
    />,
  );
  const trigger = html.match(/<button[^>]*data-testid="composer-permission-selector"[^>]*>/)?.[0];
  expect(trigger).toBeDefined();
  expect(html).toContain('aria-label="Permissions: Ask for approval"');
  expect(html).toContain("Ask for approval");
  expect(trigger).not.toContain("disabled");

  const active = renderToStaticMarkup(
    <TaskPermissionSelector
      task={runtime as never}
      snapshot={{ ...idle, activeTurnId: "turn-a" } as TaskSnapshot}
      demo={false}
    />,
  );
  const activeTrigger = active.match(/<button[^>]*data-testid="composer-permission-selector"[^>]*>/)?.[0];
  expect(activeTrigger).toContain("disabled");
  const demo = renderToStaticMarkup(
    <TaskPermissionSelector
      task={runtime as never}
      snapshot={idle}
      demo
    />,
  );
  const demoTrigger = demo.match(/<button[^>]*data-testid="composer-permission-selector"[^>]*>/)?.[0];
  expect(demoTrigger).toBeDefined();
  expect(demoTrigger).not.toContain("disabled");
  expect(demo).toContain("Default");
  expect(demo).toContain("Opens a read-only preview. It cannot change a real task.");
});
