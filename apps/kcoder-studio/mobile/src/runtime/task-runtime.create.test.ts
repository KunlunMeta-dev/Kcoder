import { loadPendingThreadCreation, savePendingThreadCreation, pendingThreadCreationKey, linkedCreationIntent } from "@/storage/pending-thread-creation";
import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import { MobileRpcError } from "@/gateway/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
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
  installBrowserProfileFixture([profile]);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.mocked(gatewaySessionExpired).mockResolvedValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
  vi.useRealTimers();
});
describe("TaskRuntime.create", () => {
  it("routes session and one-turn modes explicitly and rejects unsupported servers before creation", async () => {
    const client = new FakeClient([]);
    const supportsExperimental = vi.fn(() => false);
    Object.assign(client, { supportsExperimental });
    client.close = vi.fn();
    client.request = vi.fn(async (method: string) => {
      if (method === "thread/start")
        return { thread: { id: "mode-thread" } } as never;
      if (method === "turn/start")
        return { turn: { id: "mode-turn" } } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    await expect(
      TaskRuntime.create({
        profile,
        server,
        cwd: "/workspace",
        prompt: "test",
        sessionMode: "orchestrate",
      }),
    ).rejects.toThrow("升级");
    expect(client.request).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    supportsExperimental.mockImplementation((capability?: string) => capability === "sessionModes");
    const task = await TaskRuntime.create({
      profile,
      server,
      cwd: "/workspace",
      prompt: "plan",
      sessionMode: "orchestrate",
      turnMode: "moa-plan",
    });
    expect(client.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({ sessionMode: "orchestrate" }),
    );
    expect(client.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ turnMode: "moa-plan" }),
    );
    task.close();
  });

  it("closes the client when thread/start rejects before returning a thread id", async () => {
    const calls: string[] = [];
    const client = new FakeClient([]);
    const startError = new MobileRpcError(
      "thread/start response timed out",
      -1,
      "transport",
    );
    client.close = vi.fn();
    client.request = vi.fn(async (method: string) => {
      calls.push(method);
      if (method === "thread/start") throw startError;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    await expect(
      TaskRuntime.create({
        profile,
        server,
        cwd: "/workspace",
        prompt: "创建任务超时",
      }),
    ).rejects.toBe(startError);

    expect(calls).toEqual(["thread/start"]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up the known empty thread when the managed-worktree connector rejects", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const primaryClient = new FakeClient([]);
    const registryConnectError = new Error("managed-worktree connector failed");
    primaryClient.close = vi.fn();
    primaryClient.request = vi.fn(
      async (method: string, params: JsonRecord = {}) => {
        calls.push({ method, params });
        if (method === "thread/start")
          return {
            thread: { id: "created-before-registry-connect" },
          } as never;
        if (method === "thread/delete") return { deleted: true } as never;
        return {} as never;
      },
    );
    const connector = vi.fn(async (_profile, _server, cwd: string) => {
      if (cwd === "/managed/source") throw registryConnectError;
      return primaryClient as never;
    });
    taskRuntimeTestHelpers.setConnector(connector as never);

    await expect(
      TaskRuntime.create({
        profile,
        server,
        cwd: "/managed/worktree",
        managedWorktreeSourcePath: "/managed/source",
        prompt: "创建worktree任务",
      }),
    ).rejects.toBe(registryConnectError);

    expect(connector).toHaveBeenCalledTimes(2);
    expect(connector.mock.calls.map(([, , cwd]) => cwd)).toEqual([
      "/managed/worktree",
      "/managed/source",
    ]);
    expect(calls).toEqual([
      { method: "thread/start", params: { cwd: "/managed/worktree" } },
      {
        method: "thread/delete",
        params: { threadId: "created-before-registry-connect" },
      },
    ]);
    expect(calls.some(({ method }) => method === "turn/start")).toBe(false);
    expect(primaryClient.close).toHaveBeenCalledTimes(1);
  });

  it("turn 启动失败时尽力删除刚创建的空 resident thread", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const client = new FakeClient([]);
    client.close = vi.fn();
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "thread/start")
        return { thread: { id: "empty-thread" } } as never;
      if (method === "turn/start")
        throw new MobileRpcError("turn rejected", -32602, "remote");
      if (method === "thread/delete") return { deleted: true } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    await expect(
      TaskRuntime.create({
        profile,
        server,
        cwd: "/workspace",
        prompt: "失败创建",
      }),
    ).rejects.toThrow("turn rejected");
    expect(calls.at(-1)).toEqual({
      method: "thread/delete",
      params: { threadId: "empty-thread" },
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("uses the model confirmed by thread/start when the client leaves it unspecified", async () => {
    const calls: Array<{ method: string; params: JsonRecord }> = [];
    const client = new FakeClient([]);
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "thread/start") {
        return {
          thread: { id: "server-default", model: "MiniMax-M3" },
        } as never;
      }
      if (method === "turn/start") return { turn: { id: "turn-1" } } as never;
      return {} as never;
    });
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    const runtime = await TaskRuntime.create({
      profile,
      server,
      cwd: "/workspace",
      prompt: "使用服务端默认模型",
    });

    expect(runtime.getSnapshot().model).toBe("MiniMax-M3");
    expect(calls).toContainEqual({
      method: "turn/start",
      params: {
        threadId: "server-default",
        input: [{ type: "text", text: "使用服务端默认模型" }],
        clientMessageId: expect.any(String),
        model: "MiniMax-M3",
      },
    });
    runtime.close();
  });
});

it("omits default first-turn permission and rejects explicit unsupported permission before thread/start", async () => {
  const client = new FakeClient([]); const request = vi.fn(async (method: string, _params: JsonRecord = {}) => method === "thread/start" ? { thread: { id: "permission-thread" } } : method === "turn/start" ? { turn: { id: "permission-turn" } } : {});
  client.request = request as never; taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  await expect(TaskRuntime.create({ profile, server, cwd: "/permission", prompt: "first", permissionMode: "ask" })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  const task = await TaskRuntime.create({ profile, server, cwd: "/permission", prompt: "first", permissionMode: "default" });
  expect(request.mock.calls.find(call => call[0] === "turn/start")?.[1]).not.toHaveProperty("permissionMode"); task.close();
});
it("sends explicit first-turn permission and reasoning on the initialized target", async () => {
  const client = new FakeClient([]); client.supportsExperimental = (name: string) => name === "turnPermissions";
  const request = vi.fn(async (method: string, _params: JsonRecord = {}) => method === "thread/start" ? { thread: { id: "configured-thread" } } : method === "turn/start" ? { turn: { id: "configured-turn" } } : {});
  client.request = request as never; taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  const task = await TaskRuntime.create({ profile, server, cwd: "/permission", prompt: "first", permissionMode: "accept_edits", reasoningEffort: "high" });
  expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ permissionMode: "accept_edits", reasoningEffort: "high", input: [{ type: "text", text: "first" }] }));
  expect(task.getSnapshot().permissionMode).toBe("accept_edits"); task.close();
});

it("passes the frozen expert version on the original thread/start only", async () => {
  const agentDefinition = { id: "expert-review", version: "v3", definitionSha256: "a".repeat(64) };
  const client = new FakeClient([]);
  client.supportsExperimental = capability => ["agentDefinitionsV1", "threadCreationReceiptsV1", "sessionModes"].includes(capability);
  const request = vi.fn(async (method: string, _params: JsonRecord = {}) => method === "thread/start"
    ? { thread: { id: "expert-thread", cwd: "/expert" } }
    : method === "turn/start" ? { turn: { id: "expert-turn" } } : {});
  client.request = request as never;
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);

  const task = await TaskRuntime.create({ profile, server, cwd: "/expert", prompt: "use the configured expert", turnMode: "moa-plan", agentDefinition });

  expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
    cwd: "/expert", agentDefinition, clientRequestId: expect.any(String),
  });
  expect(request.mock.calls.some(([method]) => method === "thread/expert")).toBe(false);
  expect(request.mock.calls.find(([method]) => method === "turn/start")?.[1]).toMatchObject({ turnMode: "moa-plan" });
  expect(request.mock.calls.find(([method]) => method === "turn/start")?.[1]).not.toHaveProperty("agentDefinition");
  task.close();
});

it("keeps the selected version with the original creation receipt after a lost start acknowledgement", async () => {
  const agentDefinition = { id: "expert-review", version: "v3", definitionSha256: "b".repeat(64) };
  const differentDefinition = { ...agentDefinition, version: "v4", definitionSha256: "c".repeat(64) };
  const input = { profile, server, cwd: "/expert", prompt: "recover the same creation", agentDefinition };
  const key = pendingThreadCreationKey(profile, server, input.cwd);
  const first = new FakeClient([]);
  first.supportsExperimental = capability => ["agentDefinitionsV1", "threadCreationReceiptsV1"].includes(capability);
  const firstRequest = vi.fn(async (method: string, _params: JsonRecord = {}) => {
    if (method === "thread/start") throw new MobileRpcError("lost creation acknowledgement", -1, "transport");
    if (method === "thread/creation/read") return { receipt: null };
    return {};
  });
  first.request = firstRequest as never;
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => first as never) as never);

  await expect(TaskRuntime.create(input)).rejects.toThrow();
  const original = await loadPendingThreadCreation(key);
  expect(original?.input?.agentDefinition).toEqual(agentDefinition);
  const clientRequestId = original!.clientRequestId;
  expect(firstRequest.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({ agentDefinition, clientRequestId });

  const changed = new FakeClient([]);
  changed.supportsExperimental = capability => ["agentDefinitionsV1", "threadCreationReceiptsV1"].includes(capability);
  const changedRequest = vi.fn(); changed.request = changedRequest as never;
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => changed as never) as never);
  await expect(TaskRuntime.create({ ...input, agentDefinition: differentDefinition })).rejects.toThrow();
  expect(changedRequest).not.toHaveBeenCalled();
  expect((await loadPendingThreadCreation(key))?.input?.agentDefinition).toEqual(agentDefinition);

  const recovered = new FakeClient([]);
  recovered.supportsExperimental = capability => capability === "threadCreationReceiptsV1";
  const recoveredBase = recovered.request.bind(recovered);
  const recoveredRequest = vi.fn(async (method: string, params: JsonRecord = {}) => {
    if (method === "thread/creation/read") return { receipt: { status: "ready", threadId: "expert-thread", thread: { id: "expert-thread", cwd: input.cwd } } };
    if (method === "thread/resume") return { thread: { id: "expert-thread", cwd: input.cwd, status: "idle" } };
    if (method === "thread/read") return { thread: { id: "expert-thread", cwd: input.cwd, status: "idle" }, messages: [], hasMoreBefore: false };
    if (method === "turn/start") return { turn: { id: "original-turn" } };
    return recoveredBase(method, params);
  });
  recovered.request = recoveredRequest as never;
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => recovered as never) as never);
  const task = await TaskRuntime.create(input);
  expect(recoveredRequest).toHaveBeenCalledWith("thread/creation/read", { clientRequestId });
  expect(recoveredRequest.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(0);
  expect(recoveredRequest.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  expect(await loadPendingThreadCreation(key)).toBeNull();
  task.close();
});

it.each([false, true])("recovers an already dispatched first turn by original receipt only (legacy=%s), despite lost mode capabilities", async legacy => {
  const input = { cwd: "/workspace", prompt: "frozen original", permissionMode: "ask" as const, sessionMode: "orchestrate" as const, turnMode: "moa" as const };
  const record = { clientRequestId: "old-create", intent: legacy ? JSON.stringify([input.cwd, input.prompt, null, input.sessionMode, input.turnMode, null, null]) : linkedCreationIntent(input), dispatched: true, threadId: "thread-1", turnDispatched: true,
    ...legacy ? {} : { input, initialTurnParams: { threadId: "thread-1", clientMessageId: "old-create-initial-turn", input: [{ type: "text", text: input.prompt }], permissionMode: "ask", turnMode: "moa" } } };
  const key = pendingThreadCreationKey(profile, server, input.cwd); await savePendingThreadCreation(key, profile.id, record);
  const client = new FakeClient([]); const base = client.request.bind(client);
  client.supportsExperimental = (name: string) => ["threadCreationReceiptsV1", "turnReceiptsV1"].includes(name);
  const request = vi.fn(async (method: string, params: JsonRecord = {}) => {
    if (method === "thread/creation/read") return { receipt: { status: "ready", threadId: "thread-1", thread: { id: "thread-1", cwd: input.cwd } } };
    if (method === "turn/receipt/read") return { receipt: { threadId: "thread-1", turnId: "accepted-original", status: "running" } };
    return base(method, params);
  }); client.request = request as never;
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  const task = await TaskRuntime.create({ ...input, permissionMode: legacy ? undefined : input.permissionMode, profile, server });
  expect(request).toHaveBeenCalledWith("thread/creation/read", { clientRequestId: "old-create" });
  expect(request).toHaveBeenCalledWith("turn/receipt/read", { threadId: "thread-1", clientMessageId: "old-create-initial-turn" });
  expect(request.mock.calls.filter(([method]) => method === "thread/start" || method === "turn/start")).toEqual([]);
  expect(await loadPendingThreadCreation(key)).toBeNull(); task.close();
});
it("refuses to create another thread when the original receipt capability disappears", async () => {
  const input = { cwd: "/workspace", prompt: "saved original" }; const key = pendingThreadCreationKey(profile, server, input.cwd);
  await savePendingThreadCreation(key, profile.id, { clientRequestId: "saved-create", intent: linkedCreationIntent(input), dispatched: true, input });
  const client = new FakeClient([]); client.request = vi.fn(); taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  await expect(TaskRuntime.create({ ...input, profile, server })).rejects.toThrow("原 ID");
  expect(client.request).not.toHaveBeenCalled(); expect((await loadPendingThreadCreation(key))?.clientRequestId).toBe("saved-create");
});
it("continues a definitely-unsent prepared first turn with the same creation, payload and message ID", async () => {
  const input = { cwd: "/workspace", prompt: "original prepared message", permissionMode: "ask" as const };
  const first = new FakeClient([]); const second = new FakeClient([]); const base = second.request.bind(second);
  const calls: { method: string; params: JsonRecord }[] = [];
  for (const client of [first, second]) {
    client.supportsExperimental = (name: string) => ["threadCreationReceiptsV1", "turnReceiptsV1", "turnPermissions"].includes(name);
    client.request = (async (method: string, params: JsonRecord = {}) => {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-1", cwd: input.cwd } };
      if (method === "thread/creation/read") return { receipt: { status: "ready", threadId: "thread-1", thread: { id: "thread-1", cwd: input.cwd } } };
      if (method === "turn/start") { if (client === first) throw new MobileRpcError("not sent", -1, "transport", "not-sent"); return { turn: { id: "first-turn" } }; }
      return base(method, params);
    }) as never;
  }
  taskRuntimeTestHelpers.setConnector(vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second) as never);
  await expect(TaskRuntime.create({ ...input, profile, server })).rejects.toThrow("not sent");
  const pending = await loadPendingThreadCreation(pendingThreadCreationKey(profile, server, input.cwd));
  expect(pending).toMatchObject({ dispatched: true, turnDispatched: false });
  expect(pending?.initialTurnParams).toMatchObject({ permissionMode: "ask", clientMessageId: `${pending?.clientRequestId}-initial-turn` });
  const task = await TaskRuntime.create({ ...input, profile, server });
  const starts = calls.filter(call => call.method === "turn/start"); expect(starts).toHaveLength(2); expect(starts[0].params).toEqual(starts[1].params);
  expect(calls.filter(call => call.method === "thread/start")).toHaveLength(1); expect(calls.some(call => call.method === "thread/delete")).toBe(false);
  expect(await loadPendingThreadCreation(pendingThreadCreationKey(profile, server, input.cwd))).toBeNull(); task.close();
});
it("checks current capabilities before dispatching a definitely-unsent frozen first turn", async () => {
  const input = { cwd: "/workspace", prompt: "frozen permission", permissionMode: "ask" as const };
  const params = { threadId: "thread-1", clientMessageId: "prepared-create-initial-turn", input: [{ type: "text", text: input.prompt }], permissionMode: "ask" };
  const key = pendingThreadCreationKey(profile, server, input.cwd);
  await savePendingThreadCreation(key, profile.id, { clientRequestId: "prepared-create", intent: linkedCreationIntent(input), dispatched: true, threadId: "thread-1", turnDispatched: false, input, initialTurnParams: params });
  const client = new FakeClient([]); const base = client.request.bind(client);
  client.supportsExperimental = (name: string) => ["threadCreationReceiptsV1", "turnReceiptsV1"].includes(name);
  client.request = vi.fn(async (method: string, wire: JsonRecord = {}) => method === "thread/creation/read" ? { receipt: { status: "ready", threadId: "thread-1", thread: { id: "thread-1", cwd: input.cwd } } } : base(method, wire)) as never;
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  await expect(TaskRuntime.create({ ...input, profile, server })).rejects.toThrow();
  const pending = await loadPendingThreadCreation(key); expect(pending?.turnDispatched).toBe(false); expect(pending?.initialTurnParams).toEqual(params);
  expect((client.request as any).mock.calls.some(([method]: string[]) => method === "turn/start" || method === "thread/start")).toBe(false);
});
