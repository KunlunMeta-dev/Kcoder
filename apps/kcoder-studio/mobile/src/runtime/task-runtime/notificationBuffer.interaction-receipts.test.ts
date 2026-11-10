import { afterEach, expect, test, vi } from "vitest";
import type { JsonRecord, RpcMessage } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "../task-runtime";
import { FakeClient, appServerId, profile, server } from "./fixture.test-support";
import { bufferNotifications } from "./notificationBuffer";

vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}) }));

function resolved(kind: "question" | "approval"): RpcMessage {
  return { method: `${kind}/resolved`, params: {
    threadId: "thread-1", turnId: "original-turn", requestId: 7,
    [`${kind}Id`]: "interaction-7", appServerEpoch: "original-server", reason: "answered",
  } };
}

function requested(kind: "question" | "approval", requestId: number, turnId: string): RpcMessage {
  return { id: requestId, method: `${kind}/request`, params: {
    serverId: appServerId, threadId: "thread-1", turnId, appServerEpoch: "original-server",
    ...(kind === "question"
      ? { questionId: `interaction-${requestId}`, questions: [{ id: "item", prompt: "Which mode?", options: [] }] }
      : { approvalId: `interaction-${requestId}`, action: { type: "command", command: "echo fixture" } }),
  } };
}

class RecoveryClient extends FakeClient {
  calls: string[] = [];
  override respond = vi.fn();
  override respondError = vi.fn();
  override supportsExperimental(capability: string): boolean {
    return capability === "interactionStatusReadV1";
  }
  override async request<T>(method: string, params: JsonRecord = {}): Promise<T> {
    this.calls.push(method);
    if (method === "interaction/status/read") return { ...params, status: "pending" } as T;
    return super.request<T>(method, params);
  }
}

const runtimes: TaskRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach(runtime => runtime.close());
  taskRuntimeTestHelpers.resetConnector();
});

for (const kind of ["question", "approval"] as const) {
  test.each(["resume", "reconnect"] as const)(
    `${kind} terminal replays cannot prevent %s from recovering the original task`, async mode => {
      const receipt = resolved(kind);
      const events = [requested(kind, 7, "original-turn"),
        ...Array.from({ length: 513 }, () => structuredClone(receipt))];
      events.push({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "next-turn" } } });
      events.push(requested(kind, 8, "next-turn"));
      const original = new RecoveryClient([], mode === "resume" ? events : []);
      let current = original;
      taskRuntimeTestHelpers.setConnector((async () => current as never) as never);
      const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
        profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
      runtimes.push(runtime);
      const changed = vi.fn();
      if (mode === "reconnect") {
        runtime.setInteractionLedgerObserver({ ownerFor: () => undefined, wasResolved: () => false,
          changed, resolved: vi.fn() });
        current = new RecoveryClient([], events);
        await runtime.reconnectNow();
      }
      expect(runtime.getSnapshot()).toMatchObject({
        threadId: "thread-1", connected: true, error: null, running: true, activeTurnId: "next-turn",
      });
      expect(runtime.client).toBe(current);
      expect(current.closed).toBe(false);
      expect(runtime.pendingInteractions.map(item => item.requestId)).toEqual([8]);
      expect(runtime.getSnapshot().interaction).toMatchObject({ requestId: 8 });
      if (mode === "reconnect") expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestId: 8 }), true,
      );
      for (const client of new Set([original, current])) {
        expect(client.respond).not.toHaveBeenCalled();
        expect(client.respondError).not.toHaveBeenCalled();
        expect(client.calls.some(method => ["turn/start", "asyncQuestion/answer", "asyncQuestion/cancel"].includes(method))).toBe(false);
      }
    },
  );

  test(`${kind} reconnect reads old receipts without granting their answer authority to the new connection`, async () => {
    const original = new RecoveryClient([]);
    let current = original;
    taskRuntimeTestHelpers.setConnector((async () => current as never) as never);
    const runtime = await TaskRuntime.resume({ profile, server, threadId: "thread-1",
      profileActivationEpoch: 1, isCurrentInteractionOwner: () => true });
    runtimes.push(runtime);
    original.emit(requested(kind, 6, "old-turn"));
    current = new RecoveryClient([], [requested(kind, 8, "next-turn")]);
    const read = vi.spyOn(current, "request");
    await runtime.reconnectNow();
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith("interaction/status/read",
      expect.objectContaining({ requestId: 6, turnId: "old-turn", threadId: "thread-1" })));
    expect(runtime.pendingInteractions.map(item => item.requestId)).toEqual([6, 8]);
    expect(runtime.isInteractionActionable(runtime.pendingInteractions[0]!)).toBe(false);
    expect(runtime.isInteractionActionable(runtime.pendingInteractions[1]!)).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({ interactionCount: 1, interaction: { requestId: 8 } });
    expect(current.respond).not.toHaveBeenCalled();
    expect(current.respondError).not.toHaveBeenCalled();
  });

  test(`${kind} receipt replays retain first position and do not repeatedly consume the byte budget`, () => {
    const client = new FakeClient([]);
    const buffered = bufferNotifications(client as never);
    const receipt = resolved(kind);
    receipt.params = { ...receipt.params, reason: "x".repeat(12 * 1024) };
    const progress: RpcMessage = { method: "item/delta", params: { text: "following progress" } };
    client.emit(receipt);
    client.emit(progress);
    for (let index = 0; index < 100; index++) client.emit({
      params: Object.fromEntries(Object.entries(receipt.params!).reverse()), method: receipt.method,
    });
    expect(buffered.hasOverflowed()).toBe(false);
    const receive = vi.fn();
    const stop = buffered.activate(receive);
    expect(receive.mock.calls.map(([message]) => message)).toEqual([receipt, progress]);
    // Deduplication belongs only to recovery buffering, not live receipt routing.
    client.emit(receipt);
    expect(receive).toHaveBeenCalledTimes(3);
    stop();
    expect(client.listeners.size).toBe(0);
  });
}

test.each(["threadId", "turnId", "requestId", "questionId", "appServerEpoch", "reason"])(
  "different %s receipts remain distinct and enforce the frame limit", field => {
    const client = new FakeClient([]);
    const buffered = bufferNotifications(client as never);
    for (let index = 0; index < 513; index++) {
      const receipt = resolved("question");
      receipt.params = { ...receipt.params, [field]: field === "requestId" ? index : `value-${index}` };
      client.emit(receipt);
    }
    expect(buffered.hasOverflowed()).toBe(true);
    expect(() => buffered.activate(vi.fn())).toThrow("会话更新超过缓存上限");
    expect(client.listeners.size).toBe(0);
  },
);

test("question and approval receipts with the same parameters remain distinct", () => {
  const client = new FakeClient([]);
  const buffered = bufferNotifications(client as never);
  const question = resolved("question");
  const approval = { ...question, method: "approval/resolved" };
  client.emit(question);
  client.emit(approval);
  const receive = vi.fn();
  const stop = buffered.activate(receive);
  expect(receive.mock.calls.map(([message]) => message)).toEqual([question, approval]);
  stop();
});
