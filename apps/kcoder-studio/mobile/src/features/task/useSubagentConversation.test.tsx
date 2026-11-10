import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskRuntime } from "@/runtime/task-runtime";
import type { JsonRecord, RpcMessage } from "@/gateway/rpc";
import { useSubagentConversation } from "./useSubagentConversation";
vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(), gatewaySessionExpired: vi.fn() }));
let task: TaskRuntime, renderer: ReactTestRenderer | undefined, warning: ReturnType<typeof vi.spyOn>;
let listeners: Set<(message: RpcMessage) => void>, requests: Array<{ method: string; params: JsonRecord }>;
function Probe({ id = "first", scope = "first-scope", enabled = true }) {
  const value = useSubagentConversation(task, id, scope, enabled, () => true);
  return React.createElement("probe", { value });
}
const value = () => renderer!.root.findByType("probe" as never).props.value;
const tick = async (ms = 1) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => {
  vi.useFakeTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  warning = vi.spyOn(console, "error").mockImplementation((...args) => {
    if (!String(args[0]).includes("react-test-renderer is deprecated")) throw new Error(args.map(String).join(" "));
  });
  task = TaskRuntime.demo("parent"); task.snapshot = { ...task.snapshot, connected: true };
  listeners = new Set(); requests = [];
  task.client = { supportsExperimental: () => true,
    subscribe: (listener: (message: RpcMessage) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    request: async (method: string, params: JsonRecord) => { requests.push({ method, params }); return method === "agent/stream/subscribe"
      ? { ...params, runId: "run", sequence: 1, active: true, status: "running", activeAssistantItemId: "assistant",
        messages: [{ id: "assistant", role: "assistant", content: String(params.agentId), timestampMs: 1, status: "streaming" }] } : {}; },
    close: () => {},
  } as never;
});
afterEach(async () => {
  await act(async () => { renderer?.unmount(); }); renderer = undefined;
  task.close(); warning.mockRestore(); vi.useRealTimers(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
it("installs the snapshot and incremental text, then fences the old worker when the selected identity changes", async () => {
  await act(async () => { renderer = create(<Probe />); }); await tick();
  const first = requests.find(row => row.method === "agent/stream/subscribe")!.params;
  await act(async () => { for (const listener of listeners) listener({ method: "agent/stream/event", params: {
    ...first, runId: "run", sequence: 2, method: "item/delta", params: { itemId: "assistant", delta: { text: " increment" } },
  } }); });
  expect(value().snapshot.messages[0].content).toBe("first increment");
  await act(async () => { renderer!.update(<Probe id="second" scope="second-scope" />); });
  expect(value()).toBeUndefined(); await tick();
  expect(value().snapshot.messages[0].content).toBe("second");
  await act(async () => { for (const listener of listeners) listener({ method: "agent/stream/event", params: {
    ...first, runId: "run", sequence: 3, method: "item/delta", params: { itemId: "assistant", delta: { text: " stale" } },
  } }); });
  expect(value().snapshot.messages[0].content).toBe("second");
  expect(requests.some(row => row.method === "agent/stream/unsubscribe" && row.params.subscriptionId === first.subscriptionId)).toBe(true);
  expect(listeners.size).toBe(1);
});
it("retries observation after a gap without losing history, then releases only its own subscription on close", async () => {
  await act(async () => { renderer = create(<Probe />); }); await tick();
  const params = requests.find(row => row.method === "agent/stream/subscribe")!.params;
  await act(async () => { for (const listener of [...listeners]) listener({ method: "agent/stream/event", params: {
    ...params, runId: "run", sequence: 4, method: "item/delta", params: { itemId: "assistant", delta: { text: "missing prefix" } },
  } }); });
  expect(value().loading).toBe(true); expect(value().snapshot.running).toBe(false);
  expect(value().snapshot.messages[0].content).toBe("first"); await tick();
  expect(value().loading).toBe(false);
  await act(async () => { renderer!.update(<Probe enabled={false} />); });
  expect(listeners.size).toBe(0);
  expect(value().snapshot.messages[0].content).toBe("first");
  expect(value().snapshot.messages[0].status).toBe("interrupted");
  expect(value().snapshot.connected).toBe(false);
  expect(requests.every(row => row.method.startsWith("agent/stream/"))).toBe(true);
  expect(task.isDisposed()).toBe(false);
});

it("retains readable history while a replacement transport admits its fresh snapshot", async () => {
  await act(async () => { renderer = create(<Probe />); }); await tick();
  await act(async () => { renderer!.update(<Probe enabled={false} />); });
  expect(value().snapshot.messages[0].content).toBe("first");
  let resolve: (value: JsonRecord) => void = () => {};
  const client = task.client!;
  client.request = (async (_method: string, params: JsonRecord) => new Promise(done => { resolve = data => done({ ...params, ...data }); })) as never;
  task.clientGeneration++;
  await act(async () => { renderer!.update(<Probe />); }); await tick();
  expect(value().loading).toBe(true);
  expect(value().snapshot.messages[0].content).toBe("first");
  await act(async () => { resolve({ threadId: "parent", agentId: "first", runId: "run", sequence: 3, active: false,
    status: "completed", messages: [{ id: "fresh", role: "assistant", content: "Fresh authority", timestampMs: 2 }] }); });
  expect(value().snapshot.messages[0].content).toBe("Fresh authority");
});
