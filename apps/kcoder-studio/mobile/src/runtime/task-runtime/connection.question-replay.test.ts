import { afterEach, expect, test } from "vitest";
import type { RpcMessage } from "@/gateway/rpc";
import { TaskRuntime } from "../task-runtime";
import { FakeClient } from "./fixture.test-support";
import { bufferNotifications } from "./notificationBuffer";

const changed: RpcMessage = { method: "asyncQuestion/changed", params: {
  threadId: "thread-1", question: { threadId: "thread-1", questionId: "question-1", revision: 1 },
} };
const runtimes: TaskRuntime[] = [];
afterEach(() => { runtimes.splice(0).forEach(runtime => runtime.close()); });

test("closing during cached question replay releases the activating subscription", () => {
  const runtime = TaskRuntime.demo("thread-1");
  runtimes.push(runtime);
  const client = new FakeClient([]);
  const buffered = bufferNotifications(client as never);
  client.emit(changed);
  runtime.subscribeProtocol(() => runtime.close());

  runtime.attachBufferedClient(client as never, buffered);

  expect(runtime.disposed).toBe(true);
  expect(client.closed).toBe(true);
  expect(client.listeners.size).toBe(0);
  expect(runtime.unsubscribeRpc).toBeNull();
});

test.each(["live", "buffered"] as const)(
  "replacing the connection during question replay retains the new %s subscription's cleanup",
  mode => {
    const runtime = TaskRuntime.demo("thread-1");
    runtimes.push(runtime);
    const original = new FakeClient([]), replacement = new FakeClient([]);
    const buffered = bufferNotifications(original as never);
    original.emit(changed);
    const stop = runtime.subscribeProtocol(() => {
      stop();
      if (mode === "live") runtime.attachClient(replacement as never);
      else runtime.attachBufferedClient(replacement as never, bufferNotifications(replacement as never));
    });

    runtime.attachBufferedClient(original as never, buffered);

    expect(runtime.client).toBe(replacement);
    expect(original.listeners.size).toBe(0);
    expect(replacement.listeners.size).toBe(1);
    runtime.close();
    expect(replacement.closed).toBe(true);
    expect(replacement.listeners.size).toBe(0);
  },
);
