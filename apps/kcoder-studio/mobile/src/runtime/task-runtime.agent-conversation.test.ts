import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JsonRecord, RpcMessage } from "@/gateway/rpc";
import { TaskRuntime } from "./task-runtime";
import { observeAgentConversation, type AgentConversationView } from "./task-runtime/agent-conversation";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(), gatewaySessionExpired: vi.fn() }));
let parent: TaskRuntime, stop: (() => void) | undefined;
let listeners: Set<(message: RpcMessage) => void>, views: AgentConversationView[], allowed: boolean;
let subscribeResponse: (params: JsonRecord) => Promise<JsonRecord>;
let requests: Array<{ method: string; params: JsonRecord }>;
const initial = (params: JsonRecord): JsonRecord => ({ ...params, runId: "run-1", sequence: 1, active: true, status: "running",
  activeAssistantItemId: "a1", messages: [
    { id: "u1", role: "user", content: "Check the project", timestampMs: 1 },
    { id: "a1", role: "assistant", content: "", timestampMs: 2, status: "streaming" },
  ] });
const subscription = () => requests.filter(row => row.method === "agent/stream/subscribe").at(-1)!.params;
const emit = (sequence: number, method: string, params: JsonRecord, envelope: JsonRecord = {}) => {
  const message = { method: "agent/stream/event", params: { ...subscription(), runId: "run-1", sequence, method, params, ...envelope } };
  for (const listener of [...listeners]) listener(message);
};
const tick = async (ms = 1) => { await vi.advanceTimersByTimeAsync(ms); };
beforeEach(() => {
  vi.useFakeTimers(); views = []; allowed = true; requests = []; listeners = new Set();
  parent = TaskRuntime.demo("parent");
  parent.snapshot = { ...parent.snapshot, connected: true, messages: [{ id: "parent-message", role: "user", content: "Parent draft", timestampMs: 1 }] };
  subscribeResponse = async params => initial(params);
  parent.client = {
    supportsExperimental: (name: string) => name === "agentConversationStreamV1",
    subscribe: (listener: (message: RpcMessage) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    request: vi.fn(async (method: string, params: JsonRecord) => {
      requests.push({ method, params });
      return method === "agent/stream/subscribe" ? subscribeResponse(params) : {};
    }), close: vi.fn(),
  } as never;
});
afterEach(() => { stop?.(); stop = undefined; parent.close(); vi.useRealTimers(); });
const start = () => { stop = observeAgentConversation(parent, "child", view => views.push(view), { isCurrent: () => allowed }); };
it("normalizes roles, thinking and tools with the ordinary reducer; terminal observation never changes the parent", async () => {
  const before = parent.snapshot;
  start(); await tick();
  emit(2, "item/event", { event: { type: "assistant_thinking_delta", text: "Inspect files" } });
  emit(3, "item/started", { item: { id: "tool-1", type: "toolCall", name: "Read", status: "running", input: { path: "README.md" } } });
  emit(4, "item/completed", { item: { id: "tool-1", type: "toolCall", name: "Read", status: "completed", output: "Read successfully" } });
  emit(5, "item/delta", { itemId: "a1", delta: { text: "**Result**" } });
  emit(6, "turn/completed", { turn: { id: "run-1", status: "completed" } });
  const snapshot = views.at(-1)!.snapshot;
  expect(snapshot.messages.map(row => row.role)).toEqual(["user", "assistant"]);
  expect(snapshot.messages[1].thinking).toBe("Inspect files");
  expect(snapshot.messages[1].content).toBe("**Result**");
  expect(snapshot.messages[1].orderedBlocks?.map(block => block.kind)).toEqual(["thinking", "tool", "text"]);
  expect(snapshot.messages[1].tools?.[0].status).toBe("completed");
  expect(snapshot.running).toBe(false);
  expect(parent.snapshot).toBe(before);
  stop!(); expect(listeners.size).toBe(0);
  expect(requests.map(row => row.method)).not.toContain("turn/interrupt");
});
it("buffers frames before admission, ignores foreign/replayed frames, and recovers a missing cursor without replaying commands", async () => {
  let resolve: (value: JsonRecord) => void = () => {};
  subscribeResponse = params => new Promise(done => { resolve = done; });
  start(); await tick();
  emit(2, "item/delta", { itemId: "a1", delta: { text: "A" } });
  resolve(initial(subscription())); await tick();
  emit(2, "item/delta", { itemId: "a1", delta: { text: "A" } });
  emit(3, "item/delta", { itemId: "a1", delta: { text: "foreign" } }, { agentId: "other" });
  expect(views.at(-1)!.snapshot.messages[1].content).toBe("A");
  emit(4, "item/delta", { itemId: "a1", delta: { text: "gap" } });
  expect(views.at(-1)!.error).toContain("sequence");
  subscribeResponse = async params => ({ ...initial(params), sequence: 4 });
  await tick();
  expect(requests.filter(row => row.method === "agent/stream/subscribe")).toHaveLength(2);
  expect(requests.every(row => row.method.startsWith("agent/stream/"))).toBe(true);
});
it("preserves distinct projections at one cursor and resets atomically to the new snapshot", async () => {
  start(); await tick();
  emit(2, "item/started", { item: { id: "a2", type: "agentMessage" } });
  emit(2, "item/delta", { itemId: "a2", delta: { text: "new" } });
  expect(views.at(-1)!.snapshot.messages.at(-1)?.content).toBe("new");
  for (const listener of listeners) listener({ method: "agent/stream/reset", params: { ...initial(subscription()), sequence: 8,
    active: false, activeAssistantItemId: null, messages: [{ id: "done", role: "assistant", content: "Authoritative", timestampMs: 3 }] } });
  expect(views.at(-1)!.snapshot.messages.map(row => row.content)).toEqual(["Authoritative"]);
  emit(7, "item/delta", { itemId: "a2", delta: { text: "old" } });
  expect(views.at(-1)!.snapshot.messages).toHaveLength(1);
});
it("settles unresolved tools as unknown on terminal or connection gaps", async () => {
  start(); await tick();
  emit(2, "item/started", { item: { id: "pending", type: "toolCall", name: "Shell", status: "running" } });
  emit(3, "turn/completed", { turn: { id: "run-1", status: "failed" } });
  expect(views.at(-1)!.snapshot.messages[1].tools?.[0].status).toBe("unknown");
  expect(views.at(-1)!.snapshot.messages[1].status).toBe("failed");
});
it("a late admission after close releases the original subscription, and owner changes cannot publish", async () => {
  let resolve: (value: JsonRecord) => void = () => {};
  subscribeResponse = () => new Promise(done => { resolve = done; });
  start(); await tick(); const params = subscription();
  stop!(); const count = views.length;
  resolve(initial(params)); await tick();
  expect(views).toHaveLength(count); expect(listeners.size).toBe(0);
  expect(requests.filter(row => row.method === "agent/stream/unsubscribe").every(row => row.params.subscriptionId === params.subscriptionId)).toBe(true);
});
it("bounds queued frames and retries with a new subscription", async () => {
  subscribeResponse = () => new Promise(() => {});
  start(); await tick();
  emit(2, "item/delta", { itemId: "a1", delta: { text: "x".repeat(1024 * 1024) } });
  expect(views.at(-1)!.error).toContain("buffer");
  await tick(); expect(requests.filter(row => row.method === "agent/stream/subscribe")).toHaveLength(2);
});
it("routes late tools to their original assistant while subsequent thinking stays on the current assistant", async () => {
  start(); await tick();
  emit(2, "item/started", { item: { id: "old-tool", type: "toolCall", name: "Read", status: "running" } });
  emit(3, "item/started", { item: { id: "a2", type: "agentMessage" } });
  emit(4, "item/completed", { item: { id: "old-tool", type: "toolCall", name: "Read", status: "completed", output: "Done" } });
  emit(5, "item/event", { event: { type: "assistant_thinking_delta", text: "Next item" } });
  expect(views.at(-1)!.snapshot.messages.find(row => row.id === "a1")?.tools?.[0].status).toBe("completed");
  expect(views.at(-1)!.snapshot.messages.find(row => row.id === "a2")?.thinking).toBe("Next item");
});
it("late frames from another client generation or authorization scope never publish", async () => {
  start(); await tick(); const count = views.length;
  allowed = false;
  emit(2, "item/delta", { itemId: "a1", delta: { text: "revoked" } });
  expect(views).toHaveLength(count);
  allowed = true; parent.clientGeneration++;
  emit(3, "item/delta", { itemId: "a1", delta: { text: "stale transport" } });
  expect(views).toHaveLength(count);
});
it("restores failed terminal snapshots without displaying completed status", async () => {
  subscribeResponse = async params => ({ ...initial(params), active: false, status: "failed",
    messages: [{ id: "a1", role: "assistant", content: "Partial result", timestampMs: 2, status: "done" }] });
  start(); await tick();
  expect(views.at(-1)!.snapshot.messages[0].status).toBe("failed");
  expect(views.at(-1)!.snapshot.running).toBe(false);
});
it("appends to a restored active text run without splitting a paragraph or duplicating the snapshot prefix", async () => {
  subscribeResponse = async params => ({ ...initial(params), messages: [
    { id: "a1", role: "assistant", content: "Prefix", timestampMs: 2, status: "streaming" },
  ] });
  start(); await tick();
  emit(2, "item/delta", { itemId: "a1", delta: { text: " suffix" } });
  const row = views.at(-1)!.snapshot.messages[0];
  expect(row.content).toBe("Prefix suffix");
  expect(row.orderedBlocks?.filter(block => block.kind === "text").map(block => block.content)).toEqual(["Prefix suffix"]);
});
it("continues snapshot thinking in place and preserves the boundary after its following tool", async () => {
  subscribeResponse = async params => ({ ...initial(params), messages: [
    { id: "a1", role: "assistant", content: "", timestampMs: 2, status: "streaming",
      blocks: [{ id: "thinking", type: "thinking", content: "Inspect" }] },
  ] });
  start(); await tick();
  emit(2, "item/event", { event: { type: "assistant_thinking_delta", text: " more" } });
  emit(3, "item/started", { item: { id: "read", type: "toolCall", name: "Read", status: "running" } });
  emit(4, "item/event", { event: { type: "assistant_thinking_delta", text: "Next step" } });
  const blocks = views.at(-1)!.snapshot.messages[0].orderedBlocks!;
  expect(blocks.map(block => block.kind)).toEqual(["thinking", "tool", "thinking"]);
  expect(blocks.filter(block => block.kind === "thinking").map(block => block.content)).toEqual(["Inspect more", "Next step"]);
});
