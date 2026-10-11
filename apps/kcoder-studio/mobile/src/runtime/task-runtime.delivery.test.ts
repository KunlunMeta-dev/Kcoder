import { gatewaySessionExpired } from "@/gateway/http";
import { GatewayRpcClient, type RpcMessage } from "@/gateway/rpc";
import type { ThreadMessage } from "@/gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { profile, server } from "./task-runtime/fixture.test-support";

vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));

type Frame = RpcMessage & { params?: Record<string, unknown> };
type TurnStartBehavior = "complete" | "close-after-write" | "throw-from-send" | "invalid-reply";

class DeliveryWebSocket {
  static OPEN = 1;
  static instances: DeliveryWebSocket[] = [];
  static history: ThreadMessage[] = [];

  readyState = DeliveryWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sendInvocations: Frame[] = [];
  readonly writtenFrames: Frame[] = [];
  turnStartBehavior: TurnStartBehavior = "complete";

  constructor() {
    DeliveryWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(raw: string): void {
    const frame = JSON.parse(raw) as Frame;
    this.sendInvocations.push(frame);
    if (frame.method === "turn/start" && this.turnStartBehavior === "throw-from-send")
      throw new Error("native WebSocket send failed after readiness check");
    this.writtenFrames.push(frame);
    if (typeof frame.id !== "number") return;

    if (frame.method === "initialize") {
      this.reply(frame.id, {
        protocolVersion: "2026-07-27",
        capabilities: {
          threadResume: true,
          experimental: {
            turnReceiptsV1: true,
            failedTurnContinuationV1: true,
            turnRetryOperationV1: true,
            turnAttemptRetryV1: true,
            threadRunSummaryV1: true,
          },
        },
      });
      return;
    }
    if (frame.method === "thread/resume") {
      this.reply(frame.id, {
        thread: { id: "thread-1", cwd: "/workspace", status: "idle" },
      });
      return;
    }
    if (frame.method === "thread/read") {
      this.reply(frame.id, {
        thread: { id: "thread-1", cwd: "/workspace", status: "idle" },
        messages: DeliveryWebSocket.history,
        hasMoreBefore: false,
      });
      return;
    }
    if (frame.method === "turn/start") {
      if (this.turnStartBehavior === "close-after-write") {
        queueMicrotask(() => {
          this.readyState = 3;
          this.onclose?.();
        });
        return;
      }
      this.reply(
        frame.id,
        this.turnStartBehavior === "invalid-reply"
          ? { turn: { status: "completed" } }
          : { turn: { id: "turn-1", status: "completed" } },
      );
      return;
    }
    if (frame.method === "turn/receipt/read") {
      this.reply(frame.id, { receipt: null });
      return;
    }
    this.reply(frame.id, {});
  }

  close(): void {
    this.readyState = 3;
  }

  private reply(id: number, result: unknown): void {
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({ jsonrpc: "2.0", id, result }),
      }),
    );
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  DeliveryWebSocket.instances = [];
  DeliveryWebSocket.history = [];
  globalThis.WebSocket = DeliveryWebSocket as unknown as typeof WebSocket;
  taskRuntimeTestHelpers.setConnector(GatewayRpcClient.connect as never);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});

afterEach(() => {
  taskRuntimeTestHelpers.resetConnector();
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function resumeRuntime(): Promise<TaskRuntime> {
  return TaskRuntime.resume({ profile, server, threadId: "thread-1" });
}

function frames(method: string): Frame[] {
  return DeliveryWebSocket.instances.flatMap((socket) =>
    socket.writtenFrames.filter((frame) => frame.method === method),
  );
}

describe("Mobile RPC turn delivery classification", () => {
  it("treats a pre-send readiness failure as definitely unsent and allows the same stable ID to retry", async () => {
    const runtime = await resumeRuntime();
    const client = runtime.client!;
    const request = vi.spyOn(client, "request");
    const socket = DeliveryWebSocket.instances[0]!;
    socket.readyState = 3;

    let caught: unknown;
    try {
      await runtime.startOrdinaryTurn({
        threadId: "thread-1",
        input: [{ type: "text", text: "fresh message" }],
      });
    } catch (error) {
      caught = error;
    }

    const turnStartWrites = frames("turn/start").length;
    const receiptRequests = request.mock.calls.filter(
      ([method]) => method === "turn/receipt/read",
    ).length;
    expect(turnStartWrites, "socket writes before any retry").toBe(0);
    expect(receiptRequests, `turn/start socket writes were ${turnStartWrites}`).toBe(0);
    expect(caught).toMatchObject({
      name: "MobileRpcError",
      delivery: "not-sent",
    });
    expect(runtime.getSnapshot().sendAcceptanceUnknown).not.toBe(true);

    const startRequest = request.mock.calls.find(
      ([method]) => method === "turn/start",
    );
    if (!startRequest) throw new Error("turn/start was not attempted");
    const startParams = startRequest[1];
    if (!startParams) throw new Error("turn/start had no params");
    const generatedId = startParams.clientMessageId;
    if (typeof generatedId !== "string")
      throw new Error("turn/start did not include a generated clientMessageId");
    expect(generatedId).toMatch(/^mobile-/);
    socket.readyState = DeliveryWebSocket.OPEN;
    await runtime.send("fresh message", [], undefined, {
      clientMessageId: String(generatedId),
    });
    expect(frames("turn/start")).toHaveLength(1);
    expect(frames("turn/start")[0]?.params?.clientMessageId).toBe(generatedId);
    runtime.close();
  });

  it("keeps a written turn start unknown after ACK loss and blocks same-ID replay when receipt is absent", async () => {
    const runtime = await resumeRuntime();
    const firstSocket = DeliveryWebSocket.instances[0]!;
    firstSocket.turnStartBehavior = "close-after-write";

    await runtime.send("accepted but reply lost");
    const start = frames("turn/start");
    expect(start).toHaveLength(1);
    const clientMessageId = start[0]?.params?.clientMessageId;
    expect(typeof clientMessageId).toBe("string");
    expect(runtime.getSnapshot().sendAcceptanceUnknown).toBe(true);
    expect(frames("turn/receipt/read")).toHaveLength(1);

    await expect(
      runtime.send("accepted but reply lost", [], undefined, {
        clientMessageId: String(clientMessageId),
      }),
    ).rejects.toThrow("先核对执行状态");
    expect(frames("turn/start")).toHaveLength(1);
    runtime.close();
  });

  it("keeps a socket.send exception ambiguous even though readiness passed", async () => {
    const runtime = await resumeRuntime();
    const socket = DeliveryWebSocket.instances[0]!;
    socket.turnStartBehavior = "throw-from-send";

    await runtime.send("socket send throws");
    expect(socket.sendInvocations.filter((frame) => frame.method === "turn/start")).toHaveLength(1);
    expect(frames("turn/receipt/read")).toHaveLength(1);
    expect(runtime.getSnapshot().sendAcceptanceUnknown).toBe(true);
    runtime.close();
  });

  it("keeps invalid turn/start replies ambiguous", async () => {
    const runtime = await resumeRuntime();
    DeliveryWebSocket.instances[0]!.turnStartBehavior = "invalid-reply";

    await runtime.send("invalid response");
    expect(frames("turn/start")).toHaveLength(1);
    expect(frames("turn/receipt/read")).toHaveLength(1);
    expect(runtime.getSnapshot().sendAcceptanceUnknown).toBe(true);
    runtime.close();
  });

  it("does not mark a failed-attempt continuation unknown when its request never reaches the socket", async () => {
    DeliveryWebSocket.history = [
      {
        id: "user-original",
        role: "user",
        turnId: "turn-1",
        content: "original request",
        timestampMs: 1,
      },
      {
        id: "failure-original",
        role: "assistant",
        turnId: "turn-1",
        attemptId: "turn-1",
        status: "failed",
        content: "partial result",
        timestampMs: 2,
      },
    ];
    const runtime = await resumeRuntime();
    const socket = DeliveryWebSocket.instances[0]!;
    socket.readyState = 3;

    let caught: unknown;
    try {
      await runtime.continueFailed("failure-original");
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: "MobileRpcError",
      delivery: "not-sent",
    });
    expect(runtime.continuationState("failure-original").unknown).toBe(false);
    expect(frames("turn/start")).toHaveLength(0);
    expect(frames("turn/receipt/read")).toHaveLength(0);
    runtime.close();
  });
});
