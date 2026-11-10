import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { TaskConnectionNotice } from "./TaskConnectionNotice";
import { TaskRuntimeError } from "./TaskRuntimeError";

vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", Text: "Text", View: "View" }));
vi.mock("lucide-react-native", () => ({ CircleAlert: "CircleAlert", Info: "Info", WifiOff: "WifiOff" }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("./taskStyles", () => ({ useTaskAppearance: () => ({ styles: {}, colors: { textMuted: "gray", red: "red" } }) }));

let renderer: ReactTestRenderer | undefined;
const errorLog = vi.spyOn(console, "error").mockImplementation((...args) => {
  if (!String(args[0]).includes("react-test-renderer is deprecated")) throw new Error(args.map(String).join(" "));
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; });
afterAll(() => { errorLog.mockRestore(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

const snapshot = { connected: false, connectionPhase: "reconnecting" as const, error: "socket disconnected", messages: [] };
const nodes = (id: string) => renderer!.root.findAll(node => typeof node.type === "string" && node.props.testID === id);

test("automatic reconnect has one neutral notice; terminal failure offers retry and expandable reason", async () => {
  let finish!: () => void;
  const retry = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const props = { onReconnect: retry, onReauthorize: vi.fn() };
  const render = (value: typeof snapshot | { connected: boolean; connectionPhase?: "failed"; error: string; messages: never[] }) => <>
    <TaskRuntimeError snapshot={value} connectionNoticeOwned />
    <TaskConnectionNotice {...props} snapshot={value} />
  </>;
  await act(async () => { renderer = create(render(snapshot)); });
  expect(nodes("task-connection-notice")).toHaveLength(1);
  expect(nodes("runtime-error-banner")).toHaveLength(0);
  expect(nodes("connection-recovering")).toHaveLength(1);
  expect(nodes("connection-retry")).toHaveLength(0);
  expect(nodes("connection-notice-text")[0].props.style).not.toContainEqual({ color: "red" });
  const failed = { ...snapshot, connectionPhase: "failed" as const, error: "Automatic retry limit reached" };
  await act(async () => { renderer!.update(render(failed)); });
  expect(nodes("connection-recovering")).toHaveLength(0);
  await act(async () => { nodes("connection-notice-details")[0].props.onPress(); });
  expect(nodes("connection-notice-technical-details")[0].props.children).toBe(failed.error);
  await act(async () => { nodes("connection-retry")[0].props.onPress(); });
  expect(retry).toHaveBeenCalledTimes(1);
  expect(nodes("connection-retry")[0].props.disabled).toBe(true);
  await act(async () => { renderer!.update(render({ ...snapshot, connected: true })); finish(); });
  expect(nodes("task-connection-notice")).toHaveLength(0);
});

test("expired authorization leads to connection settings instead of another retry loop", async () => {
  const retry = vi.fn(), signIn = vi.fn();
  await act(async () => { renderer = create(<TaskConnectionNotice snapshot={{ ...snapshot, connectionPhase: "reauthorization-required" }} onReconnect={retry} onReauthorize={signIn} />); });
  expect(nodes("connection-recovering")).toHaveLength(0);
  expect(nodes("connection-retry")).toHaveLength(0);
  await act(async () => { nodes("connection-reauthorize")[0].props.onPress(); });
  expect(signIn).toHaveBeenCalledTimes(1);
  expect(retry).not.toHaveBeenCalled();
});

test("connection deduplication retains unknown-send reconciliation, provider failures and unowned consumers", async () => {
  const task = { reconnectNow: vi.fn(async () => {}), reconcileSendAcceptance: vi.fn(async () => undefined) };
  await act(async () => { renderer = create(<TaskRuntimeError snapshot={{ ...snapshot, sendAcceptanceUnknown: true }} task={task} connectionNoticeOwned />); });
  expect(nodes("runtime-error-banner")).toHaveLength(1);
  expect(nodes("runtime-reconnect")).toHaveLength(0);
  await act(async () => { nodes("runtime-reconcile-send")[0].props.onPress(); });
  expect(task.reconcileSendAcceptance).toHaveBeenCalledTimes(1);
  await act(async () => { renderer!.update(<TaskRuntimeError snapshot={{ ...snapshot, connected: true, error: "Provider refused this model" }} task={task} connectionNoticeOwned />); });
  expect(nodes("runtime-error-banner")).toHaveLength(1);
  await act(async () => { renderer!.update(<TaskRuntimeError snapshot={snapshot} task={task} />); });
  expect(nodes("runtime-reconnect")).toHaveLength(1);
  await act(async () => { nodes("runtime-reconnect")[0].props.onPress(); });
  expect(task.reconnectNow).toHaveBeenCalledTimes(1);
});

test("an assistant's existing failed-message explanation is not duplicated", async () => {
  await act(async () => { renderer = create(<TaskRuntimeError snapshot={{ connected: true, error: "Provider refused this model", messages: [
    { role: "assistant", status: "failed", error: "Provider refused this model" } as never,
  ] }} connectionNoticeOwned />); });
  expect(nodes("runtime-error-banner")).toHaveLength(0);
});
