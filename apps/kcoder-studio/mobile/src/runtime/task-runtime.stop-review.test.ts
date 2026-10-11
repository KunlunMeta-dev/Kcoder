// Model-independent stop acceptance, unknown-delivery, and reconnect state checks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewaySessionExpired } from "@/gateway/http";
import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";

vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));

const activeThread = (status: "running" | "idle") => ({
  id: "thread-stop-review",
  cwd: "/workspace",
  status,
  runSummary: {
    mainTurn: status === "running" ? "running" : "idle",
    pendingApprovals: 0,
    pendingQuestions: 0,
    activeJobs: 0,
    tasksPending: 0,
    tasksRunning: 0,
    pendingFollowups: 0,
    pendingGoals: 0,
  },
});

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});

describe("TaskRuntime stop confirmation review", () => {
  it.each([
    {
      label: "explicit remote rejection",
      error: new MobileRpcError("server rejected", 400, "remote"),
      requested: undefined,
      unknown: false,
    },
    {
      label: "known not-sent transport failure",
      error: new MobileRpcError("socket was not ready", -1, "transport", "not-sent"),
      requested: undefined,
      unknown: false,
    },
    {
      label: "timeout with unknown delivery",
      error: new MobileRpcError("request timed out"),
      requested: "turn-stop-review-active",
      unknown: true,
    },
    {
      label: "connection loss with unknown delivery",
      error: new MobileRpcError("connection closed", -1, "transport", "unknown"),
      requested: "turn-stop-review-active",
      unknown: true,
    },
  ])("classifies $label without treating uncertainty as rejection", async ({
    error,
    requested,
    unknown,
  }) => {
    const client = new FakeClient([]);
    client.request = vi.fn(async () => {
      throw error;
    }) as never;
    const runtime = TaskRuntime.demo("thread-stop-review");
    runtime.attachClient(client as never);
    runtime.patch({
      connected: true,
      running: true,
      activeTurnId: "turn-stop-review-active",
    });

    await expect(runtime.interrupt()).rejects.toBe(error);

    expect(runtime.getSnapshot()).toMatchObject({
      stopRequestedTurnId: requested,
      stopAcceptanceUnknown: unknown,
      running: true,
    });
    runtime.close();
  });

  it.each([
    { status: "idle" as const, expected: undefined, unknown: false },
    { status: "running" as const, expected: "turn-stop-review-active", unknown: true },
  ])("reconnect $status summary clears a completed stop or keeps it explicitly unknown", async ({
    status,
    expected,
    unknown,
  }) => {
    vi.useFakeTimers();
    const initial = new FakeClient([]);
    const recovered = new FakeClient([]);
    const initialRequest = initial.request.bind(initial);
    initial.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      if (method === "turn/interrupt") throw new MobileRpcError("timeout");
      return initialRequest(method, params);
    }) as never;
    const recoveredRequest = recovered.request.bind(recovered);
    recovered.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      if (method === "thread/resume") return { thread: activeThread(status) };
      if (method === "thread/read")
        return { thread: activeThread(status), messages: [] };
      return recoveredRequest(method, params);
    }) as never;
    const clients = [initial, recovered];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-stop-review",
    });
    initial.emit({
      method: "turn/started",
      params: { threadId: "thread-stop-review", turnId: "turn-stop-review-active" },
    });

    await expect(runtime.interrupt()).rejects.toThrow("timeout");
    expect(runtime.getSnapshot()).toMatchObject({
      stopRequestedTurnId: "turn-stop-review-active",
      stopAcceptanceUnknown: true,
    });
    initial.emit({ method: "connection/closed", params: { reason: "network lost" } });
    await runtime.reconnectNow();

    expect(runtime.getSnapshot().stopRequestedTurnId).toBe(expected);
    expect(runtime.getSnapshot().stopAcceptanceUnknown ?? false).toBe(unknown);
    expect(runtime.getSnapshot().running).toBe(status === "running");
    if (status === "running") {
      // A still-active authoritative summary does not imply the stop was accepted.
      expect(runtime.getSnapshot().activeTurnId).toBe("turn-stop-review-active");
    } else {
      expect(runtime.getSnapshot().activeTurnId).toBeNull();
    }
    runtime.close();
  });
});
