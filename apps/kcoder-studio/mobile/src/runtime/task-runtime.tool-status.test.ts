import { describe, expect, it, vi } from "vitest";
import { normalizeMessage } from "./task-runtime/normalizers";
import { updateTool } from "./task-runtime/snapshotReducer";
import type { TaskRuntime } from "./task-runtime";
import type { ChatMessage } from "./task-runtime/types";

function runtime() {
  const message: ChatMessage = {
    id: "assistant",
    role: "assistant",
    content: "",
    timestampMs: 1,
    turnId: "turn-1",
  };
  const host = {
    snapshot: { messages: [message] },
    ensureAssistantMessage: () => 0,
    patch: vi.fn(function (
      this: { snapshot: { messages: ChatMessage[] } },
      patch: { messages: ChatMessage[] },
    ) {
      this.snapshot = { ...this.snapshot, ...patch };
    }),
  };
  return host;
}
describe("tool lifecycle projection", () => {
  it("preserves historical future labels without rendering running or completion", () => {
    const message = normalizeMessage({
      id: "history",
      role: "assistant",
      content: "",
      timestampMs: 1,
      blocks: [
        { id: "call", type: "tool", tool_name: "Read", status: "Future-Wait" },
      ],
    });
    expect(message?.tools?.[0]).toMatchObject({
      status: "unknown",
      rawStatus: "Future-Wait",
    });
  });
  it("uses explicit live future labels even on completed notifications", () => {
    const host = runtime();
    updateTool.call(
      host as unknown as TaskRuntime,
      "turn-1",
      { id: "call", name: "Read", status: "future_cleanup" },
      true,
    );
    expect(host.snapshot.messages[0].tools?.[0]).toMatchObject({
      status: "unknown",
      rawStatus: "future_cleanup",
    });
    updateTool.call(
      host as unknown as TaskRuntime,
      "turn-1",
      { id: "call", status: "completed" },
      true,
    );
    expect(host.snapshot.messages[0].tools?.[0].status).toBe("unknown");
  });
  it("keeps current start/completion semantics and ignores late starts", () => {
    const host = runtime();
    updateTool.call(
      host as unknown as TaskRuntime,
      "turn-1",
      { id: "call", name: "Read" },
      false,
    );
    expect(host.snapshot.messages[0].tools?.[0].status).toBe("running");
    updateTool.call(
      host as unknown as TaskRuntime,
      "turn-1",
      { id: "call" },
      true,
    );
    expect(host.snapshot.messages[0].tools?.[0].status).toBe("completed");
    updateTool.call(
      host as unknown as TaskRuntime,
      "turn-1",
      { id: "call" },
      false,
    );
    expect(host.snapshot.messages[0].tools?.[0].status).toBe("completed");
  });
});

describe("future turn history", () => {
  it.each(["future_cleanup", "Failed", "Completed", ""])(
    "keeps an empty unknown attempt visible and preserves %j",
    (raw) => {
      const message = normalizeMessage({
        id: "future",
        role: "assistant",
        content: "",
        timestampMs: 1,
        status: raw,
        turnId: "turn-1",
        attemptId: "attempt-1",
      });
      expect(message).toMatchObject({
        status: "unknown",
        rawStatus: raw,
        attemptId: "attempt-1",
      });
    },
  );
  it("keeps known legacy history data intact", () => {
    const message = {
      id: "current",
      role: "assistant" as const,
      content: "Saved",
      timestampMs: 1,
      status: "completed",
      attemptId: "attempt-1",
    };
    expect(normalizeMessage(message)).toMatchObject(message);
  });
});
