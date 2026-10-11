import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import { MobileRpcError } from "@/gateway/rpc";
import type { ThreadMessage } from "@/gateway/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import {
  FakeClient,
  profile,
  server,
} from "./task-runtime/fixture.test-support";
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});
describe("Mobile ordinary send receipts", () => {
  it("keeps turn mode and attachment wire content when given a stable message identity", async () => {
    const client = new FakeClient([]);
    client.supportsExperimental = (name) =>
      name === "turnReceiptsV1" || name === "sessionModes";
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "turn/start")
        return {
          turn: { id: "turn-with-attachment", status: "completed" },
        } as never;
      if (method === "thread/resume")
        return {
          thread: { id: "thread-1", cwd: "/workspace", status: "idle" },
        } as never;
      if (method === "thread/read")
        return { messages: [], hasMoreBefore: false } as never;
      return {} as never;
    }) as never;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    const attachment = {
      filename: "notes.txt",
      mimeType: "text/plain",
      fileSize: 5,
      path: "/attachments/notes.txt",
    };

    await runtime.send("inspect these notes", [attachment], "moa", {
      clientMessageId: "queue-record-with-attachment",
    });

    const turnStart = calls.find((call) => call.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      threadId: "thread-1",
      turnMode: "moa",
      clientMessageId: "queue-record-with-attachment",
    });
    expect(turnStart?.params.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("/attachments/notes.txt"),
      },
    ]);
    runtime.close();
  });

  it("reuses a queued message identity after runtime reload and adopts its existing receipt", async () => {
    const history: ThreadMessage[] = [];
    const first = new FakeClient(history);
    const reloaded = new FakeClient(history);
    const clients = [first, reloaded];
    const submittedIds: string[] = [];
    const committedIds = new Set<string>();
    let providerExecutions = 0;
    let receiptReads = 0;

    for (const client of clients) {
      client.supportsExperimental = (name) => name === "turnReceiptsV1";
      const original = client.request.bind(client);
      client.request = async <T>(
        method: string,
        params: JsonRecord = {},
      ): Promise<T> => {
        if (method === "turn/start") {
          const clientMessageId = String(params.clientMessageId ?? "");
          submittedIds.push(clientMessageId);
          if (committedIds.has(clientMessageId))
            throw new MobileRpcError(
              "client message was already committed",
              -32047,
              "remote",
            );
          committedIds.add(clientMessageId);
          providerExecutions++;
          const now = Date.now();
          history.push(
            {
              id: "server-user",
              role: "user",
              content: "queued once",
              timestampMs: now,
              turnId: "turn-original",
            },
            {
              id: "server-assistant",
              role: "assistant",
              content: "authoritative result",
              timestampMs: now + 1,
              turnId: "turn-original",
            },
          );
          return {
            turn: { id: "turn-original", status: "completed" },
          } as T;
        }
        if (method === "turn/receipt/read") {
          receiptReads++;
          return {
            receipt: {
              threadId: "thread-1",
              turnId: "turn-original",
              status: "completed",
            },
          } as T;
        }
        return original<T>(method, params);
      };
    }

    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => clients.shift() as never) as never,
    );
    const originalRuntime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    await originalRuntime.send("queued once", [], undefined, {
      clientMessageId: "queue-record-1",
    });
    originalRuntime.close();

    const reloadedRuntime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });
    await reloadedRuntime.send("queued once", [], undefined, {
      clientMessageId: "queue-record-1",
    });

    expect(submittedIds).toEqual(["queue-record-1", "queue-record-1"]);
    expect(providerExecutions).toBe(1);
    expect(receiptReads).toBe(1);
    expect(reloadedRuntime.getSnapshot().messages).toHaveLength(2);
    expect(
      reloadedRuntime
        .getSnapshot()
        .messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(reloadedRuntime.getSnapshot().messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: "authoritative result",
        turnId: "turn-original",
      }),
    );
    reloadedRuntime.close();
  });

  it.each([false, true])(
    "recovers accepted ordinary sends without another mutation, initial receipt missing=%s",
    async (missingFirst) => {
      const history: ThreadMessage[] = [];
      const client = new FakeClient(history);
      client.supportsExperimental = (name) => name === "turnReceiptsV1";
      const original = client.request.bind(client);
      let starts = 0,
        reads = 0;
      let acceptedId: unknown;
      client.request = async <T>(
        method: string,
        params: JsonRecord = {},
      ): Promise<T> => {
        if (method === "turn/start") {
          starts++;
          acceptedId = params.clientMessageId;
          history.push(
            {
              id: "server-user",
              role: "user",
              content: "once",
              timestampMs: Date.now(),
              turnId: "ordinary-turn",
            },
            {
              id: "server-result",
              role: "assistant",
              content: "authoritative result",
              timestampMs: Date.now(),
              turnId: "ordinary-turn",
            },
          );
          throw new MobileRpcError("reply lost");
        }
        if (method === "turn/receipt/read") {
          reads++;
          expect(params.clientMessageId).toBe(acceptedId);
          return {
            receipt:
              missingFirst && reads === 1
                ? null
                : {
                    threadId: "thread-1",
                    turnId: "ordinary-turn",
                    status: "completed",
                  },
          } as T;
        }
        return original<T>(method, params);
      };
      taskRuntimeTestHelpers.setConnector(
        vi.fn(async () => client as never) as never,
      );
      const task = await TaskRuntime.resume({
        profile,
        server,
        threadId: "thread-1",
      });
      await task.send("once");
      if (missingFirst) {
        expect(task.getSnapshot().sendAcceptanceUnknown).toBe(true);
        await expect(task.send("once")).rejects.toThrow("先核对执行状态");
        await task.reconcileSendAcceptance();
      }
      expect(starts).toBe(1);
      expect(task.getSnapshot().sendAcceptanceUnknown).toBe(false);
      expect(task.getSnapshot().running).toBe(false);
      expect(
        task
          .getSnapshot()
          .messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      expect(
        task
          .getSnapshot()
          .messages.some(
            (message) => message.content === "authoritative result",
          ),
      ).toBe(true);
      task.close();
    },
  );
});
