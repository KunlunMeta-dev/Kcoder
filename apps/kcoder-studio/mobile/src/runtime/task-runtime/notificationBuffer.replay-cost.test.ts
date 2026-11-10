import { expect, test, vi } from "vitest";
import type { RpcMessage } from "@/gateway/rpc";
import { FakeClient } from "./fixture.test-support";
import { bufferNotifications } from "./notificationBuffer";

test.each(["asyncQuestion/changed", "question/resolved", "approval/resolved"])(
  "%s recovery replays have bounded serialization work on a populated queue", method => {
    const client = new FakeClient([]);
    const buffered = bufferNotifications(client as never);
    const messages: RpcMessage[] = Array.from({ length: 96 }, (_, index) => ({
      method, params: method === "asyncQuestion/changed" ? {
        threadId: "thread-1", question: {
          questionId: `question-${index}`, requestId: `request-${index}`, threadId: "thread-1",
          sourceTurnId: "source", toolCallId: `tool-${index}`, revision: 1, createdAtMs: 1,
          status: "pending", questions: [{ id: "item", header: "Mode",
            question: "x".repeat(8 * 1024), multiSelect: false, options: [] }],
        },
      } : {
        threadId: "thread-1", turnId: "source", requestId: index,
        [method === "question/resolved" ? "questionId" : "approvalId"]: `interaction-${index}`,
        appServerEpoch: "original-server", reason: "answered",
      },
    }));
    // A busy history read can retain many original prompts before reconnect
    // replays the latest snapshot. Work must scale with arriving wire bytes,
    // rather than repeatedly serializing every prompt already retained.
    const replay = structuredClone(messages.at(-1)!);
    const stringify = vi.spyOn(JSON, "stringify");
    const started = performance.now();
    let calls: number;
    try {
      messages.forEach(message => client.emit(message));
      for (let index = 0; index < 200; index++) client.emit(replay);
      calls = stringify.mock.calls.length;
    } finally {
      stringify.mockRestore();
    }
    console.info(JSON.stringify({ method, serializationCalls: calls!, elapsedMs: performance.now() - started }));
    const receive = vi.fn();
    const stop = buffered.activate(receive);
    try {
      expect(buffered.hasOverflowed()).toBe(false);
      expect(receive.mock.calls.map(([message]) => message)).toEqual(messages);
      expect(calls!).toBeLessThanOrEqual((messages.length + 200) * 3);
      // Recovery deduplication must end when live delivery starts.
      client.emit(replay);
      expect(receive).toHaveBeenCalledTimes(messages.length + 1);
    } finally {
      stop();
    }
    expect(client.listeners.size).toBe(0);
  },
);
