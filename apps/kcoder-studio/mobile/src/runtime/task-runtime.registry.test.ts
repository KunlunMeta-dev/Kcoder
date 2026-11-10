import { gatewaySessionExpired } from "@/gateway/http";
import type { JsonRecord } from "@/gateway/rpc";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TaskRuntime,
  taskRuntimeRegistry,
  taskRuntimeTestHelpers,
} from "./task-runtime";
import { TaskRuntimeRegistry } from "./task-runtime/registry";
import type { InteractionOwnerBinding, PendingInteraction } from "./task-runtime/types";
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
describe("TaskRuntimeRegistry", () => {
  it("separates Gateway target from app-server interaction identity", async () => {
    const client = new FakeClient([]);
    client.supportsExperimental = (capability) => capability === "interactionStatusReadV1";
    const originalRequest = client.request.bind(client);
    client.request = vi.fn(async <T>(method: string, params: JsonRecord = {}) => {
      if (method === "interaction/status/read") return { ...params, status: "pending" } as T;
      return originalRequest<T>(method, params);
    }) as never;
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const target = { ...server, id: "target-A", observationTargetIdentity: "target-A-identity" };
    const registry = new TaskRuntimeRegistry();
    const runtime = await TaskRuntime.resume({
      profile,
      server: target,
      threadId: "thread-1",
      profileActivationEpoch: 1,
      isCurrentInteractionOwner: () => true,
    });
    registry.put(profile.id, target.id, runtime);

    client.emit({
      id: 60,
      method: "question/request",
      params: {
        serverId: target.id,
        threadId: "thread-1",
        turnId: "turn-wrong-backend",
        appServerEpoch: "epoch-wrong-backend",
        questionId: "question-wrong-backend",
        questions: [],
      },
    });
    expect(runtime.pendingInteractions).toHaveLength(0);
    expect(registry.interactionInboxRows(profileAuthorizationScopeKey(profile))).toHaveLength(0);

    client.emit({
      id: 601,
      method: "question/request",
      params: {
        serverId: "server-engine-Wrong",
        threadId: "thread-1",
        turnId: "turn-wrong-app-server",
        appServerEpoch: "epoch-wrong-app-server",
        questionId: "question-wrong-app-server",
        questions: [],
      },
    });
    expect(runtime.pendingInteractions).toHaveLength(0);
    expect(registry.interactionInboxRows(profileAuthorizationScopeKey(profile))).toHaveLength(0);

    client.emit({
      id: 62,
      method: "question/request",
      params: {
        serverId: "server-engine-test",
        threadId: "thread-1",
        turnId: "turn-62",
        appServerEpoch: "epoch-62",
        questionId: "question-62",
        questions: [{ id: "choice", prompt: "Choose", options: [] }],
      },
    });
    const interaction = runtime.pendingInteractions[0]!;
    const row = registry.interactionInboxRows(profileAuthorizationScopeKey(profile))[0]!;
    expect(interaction.owner).toMatchObject({ serverId: "target-A", appServerId: "server-engine-test" });
    expect(row).toMatchObject({ serverId: "target-A", appServerId: "server-engine-test", liveActionable: true });
    expect(runtime.isInteractionActionable(interaction)).toBe(true);

    await runtime.reconcilePendingInteractions(true);
    expect(client.request).toHaveBeenCalledWith("interaction/status/read", expect.objectContaining({
      serverId: "server-engine-test",
      threadId: "thread-1",
      turnId: "turn-62",
      appServerEpoch: "epoch-62",
      requestId: 62,
      kind: "question",
      questionId: "question-62",
    }));
    registry.removeProfile(profile.id);
  });

  it("第九个任务不会淘汰仍在运行的最早任务", async () => {
    const clients: Array<{
      client: FakeClient;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => {
        const client = new FakeClient([]);
        const close = vi.fn(() => undefined);
        client.close = close;
        client.request = vi.fn(
          async (method: string, params: JsonRecord = {}) => {
            if (method === "thread/resume")
              return {
                thread: {
                  id: String(params.threadId),
                  title: String(params.threadId),
                  cwd: "/workspace",
                  status: "idle",
                },
              } as never;
            if (method === "thread/read") return { messages: [] } as never;
            return {} as never;
          },
        );
        clients.push({ client, close });
        return client as never;
      }) as never,
    );

    for (let index = 0; index < 9; index += 1) {
      const runtime = await TaskRuntime.resume({
        profile,
        server,
        threadId: `thread-${index}`,
      });
      if (index === 0)
        clients[0].client.emit({
          method: "turn/started",
          params: { turnId: "turn-running" },
        });
      taskRuntimeRegistry.put(profile.id, server.id, runtime);
    }

    expect(clients[0].close).not.toHaveBeenCalled();
    taskRuntimeRegistry.removeProfile(profile.id);
  });

  it("第九个任务不会淘汰仍有后台 PTY 的任务", async () => {
    const clients: Array<{
      client: FakeClient;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => {
        const client = new FakeClient([]);
        const close = vi.fn(() => undefined);
        client.close = close;
        client.request = vi.fn(
          async (method: string, params: JsonRecord = {}) => {
            if (method === "thread/resume")
              return {
                thread: {
                  id: String(params.threadId),
                  title: String(params.threadId),
                  cwd: "/workspace",
                  status: "idle",
                },
              } as never;
            if (method === "thread/read") return { messages: [] } as never;
            if (method === "terminal/start")
              return {
                session_id: "background-pty",
                cwd: "/workspace",
              } as never;
            if (method === "terminal/attach")
              return {
                session_id: params.session_id,
                cwd: "/workspace",
                transcript: "",
                through_sequence: 0,
              } as never;
            return {} as never;
          },
        );
        clients.push({ client, close });
        return client as never;
      }) as never,
    );

    for (let index = 0; index < 9; index += 1) {
      const runtime = await TaskRuntime.resume({
        profile,
        server,
        threadId: `terminal-thread-${index}`,
      });
      if (index === 0) await runtime.terminalSession("terminal-main").start();
      taskRuntimeRegistry.put(profile.id, server.id, runtime);
    }

    expect(clients[0].close).not.toHaveBeenCalled();
    expect(clients[1].close).toHaveBeenCalledOnce();
    taskRuntimeRegistry.removeProfile(profile.id);
  });

  it("归档后从 registry 移除会立即释放 RPC lease", async () => {
    const client = new FakeClient([]);
    const close = vi.fn(() => undefined);
    client.close = close;
    client.request = vi.fn(async (method: string, params: JsonRecord = {}) => {
      const threadId = String(params.threadId ?? "");
      if (method === "thread/resume") return {
        thread: { id: threadId, title: threadId, cwd: "/workspace", status: "idle" },
      } as never;
      if (method === "thread/read") return {
        thread: { id: threadId, title: threadId, cwd: "/workspace", status: "idle" },
        messages: [],
      } as never;
      return {} as never;
    }) as never;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-archive",
    });
    await runtime.archive();
    taskRuntimeRegistry.put(profile.id, server.id, runtime);

    taskRuntimeRegistry.remove(
      profile.id,
      server.id,
      runtime.getSnapshot().threadId,
    );

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("disconnect/status 更新 readonly row 状态但保留原 generation 和只读权", async () => {
    const client = new FakeClient([]);
    const originalRequest = client.request.bind(client);
    client.supportsExperimental = (capability) => capability === "interactionStatusReadV1";
    client.request = vi.fn(async <T>(method: string, params: JsonRecord = {}) => {
      if (method === "interaction/status/read") return { ...params, status: "pending" } as T;
      return originalRequest<T>(method, params);
    }) as never;
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
    const registry = new TaskRuntimeRegistry();
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
      profileActivationEpoch: 1,
      isCurrentInteractionOwner: () => true,
    });
    registry.put(profile.id, server.id, runtime);
    client.emit({
      id: 31,
      method: "approval/request",
      params: {
        serverId: "server-engine-test",
        threadId: "thread-1",
        turnId: "turn-31",
        appServerEpoch: "epoch-row-status",
        approvalId: "approval-31",
        reason: "approve",
        action: { type: "command", command: "echo" },
      },
    });
    const scope = profileAuthorizationScopeKey(profile);
    const first = registry.interactionInboxRows(scope)[0]!;
    expect(first).toMatchObject({ status: "pending", liveActionable: true, originClientGeneration: 1 });

    runtime.markInteractionsDisconnected();
    runtime.patch({ connected: false });
    expect(registry.interactionInboxRows(scope)[0]).toMatchObject({
      status: "unknown",
      liveActionable: false,
      originClientGeneration: first.originClientGeneration,
    });

    await runtime.reconcilePendingInteractions(true);
    expect(registry.interactionInboxRows(scope)[0]).toMatchObject({
      status: "pending",
      liveActionable: false,
      originClientGeneration: first.originClientGeneration,
    });
    expect(runtime.isInteractionActionable(runtime.pendingInteractions[0]!)).toBe(false);
    registry.removeProfile(profile.id);
  });

  it("身份预算按 auth scope 降级，满载 live rows 显示 overflow 且不阻断新会话", async () => {
    const firstClient = new FakeClient([]);
    const secondClient = new FakeClient([]);
    const clients = [firstClient, secondClient];
    taskRuntimeTestHelpers.setConnector(vi.fn(async () => clients.shift() as never) as never);
    const registry = new TaskRuntimeRegistry();
    const firstRuntime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
      profileActivationEpoch: 1,
      isCurrentInteractionOwner: () => true,
    });
    registry.put(profile.id, server.id, firstRuntime);

    for (let index = 1; index <= 257; index += 1) {
      firstClient.emit({
        id: index,
        method: "approval/request",
        params: {
          serverId: "server-engine-test",
          threadId: "thread-1",
          turnId: `turn-${index}`,
          appServerEpoch: `epoch-${index}`,
          approvalId: `approval-${index}`,
          reason: "approve",
          action: { type: "command", command: "echo" },
        },
      });
    }
    const firstScope = profileAuthorizationScopeKey(profile);
    expect(firstRuntime.pendingInteractions[256]?.owner.status).toBe("unknown");
    expect(registry.interactionInboxRows(firstScope)).toHaveLength(256);
    expect(registry.interactionInboxOverflow(firstScope).omittedRows).toBeGreaterThan(0);

    firstClient.emit({
      id: 258,
      method: "approval/request",
      params: {
        serverId: "server-engine-test",
        threadId: "thread-1",
        turnId: "turn-existing-epoch",
        appServerEpoch: "epoch-256",
        approvalId: "approval-existing-epoch",
        reason: "approve",
        action: { type: "command", command: "echo" },
      },
    });
    expect(firstRuntime.pendingInteractions.at(-1)?.owner.status).toBe("pending");
    expect(firstRuntime.isInteractionActionable(firstRuntime.pendingInteractions.at(-1)!)).toBe(true);
    expect(registry.interactionInboxOverflow(firstScope)).toMatchObject({ omittedRows: 2 });
    registry.clearReadonlyInteractionRows(firstScope);
    expect(registry.interactionInboxOverflow(firstScope)).toMatchObject({
      omittedRows: 1,
      mayContainUntrackedRows: true,
    });

    const secondProfile = { ...profile, id: "gateway-b", label: "B" };
    const secondRuntime = await TaskRuntime.resume({
      profile: secondProfile,
      server,
      threadId: "thread-1",
      profileActivationEpoch: 1,
      isCurrentInteractionOwner: () => true,
    });
    registry.put(secondProfile.id, server.id, secondRuntime);
    secondClient.emit({
      id: 1,
      method: "approval/request",
      params: {
        serverId: "server-engine-test",
        threadId: "thread-1",
        turnId: "turn-other-profile",
        appServerEpoch: "epoch-other-profile",
        approvalId: "approval-other-profile",
        reason: "approve",
        action: { type: "command", command: "echo" },
      },
    });
    expect(secondRuntime.pendingInteractions[0]?.owner.status).toBe("pending");
    expect(secondRuntime.isInteractionActionable(secondRuntime.pendingInteractions[0]!)).toBe(true);
    expect(registry.interactionInboxOverflow(profileAuthorizationScopeKey(secondProfile)).omittedRows).toBeGreaterThan(0);
    registry.removeProfile(profile.id);
    registry.removeProfile(secondProfile.id);
  });

  it("64 个身份 scope 达上限后只降级未跟踪 scope，已跟踪 scope仍可继续", () => {
    const registry = new TaskRuntimeRegistry();
    const policy = registry as unknown as {
      ownerForInteraction(profileId: string, interaction: PendingInteraction): InteractionOwnerBinding | undefined;
    };
    const createInteraction = (scope: string, requestId: number): PendingInteraction => ({
      kind: "approval",
      requestId,
      approvalId: `approval-${requestId}`,
      reason: "approve",
      action: { type: "command", command: "echo" },
      owner: {
        profileId: scope,
        profileAuthorizationScopeKey: scope,
        serverId: "local",
        appServerId: "server-engine-test",
        serverConfigIdentity: "local-target",
        threadId: "thread-1",
        turnId: `turn-${requestId}`,
        appServerEpoch: "epoch-1",
        runtimeInstanceNonce: requestId,
        profileActivationEpoch: 1,
        originClientGeneration: 1,
        status: "pending",
      },
    });

    for (let index = 0; index < 64; index += 1)
      expect(policy.ownerForInteraction(`profile-${index}`, createInteraction(`profile-${index}`, 1))).toBeUndefined();
    expect(policy.ownerForInteraction("profile-64", createInteraction("profile-64", 1))?.status).toBe("unknown");
    expect(registry.interactionInboxOverflow("profile-64")).toEqual({
      omittedRows: 0,
      mayContainUntrackedRows: true,
    });
    expect(policy.ownerForInteraction("profile-0", createInteraction("profile-0", 2))).toBeUndefined();
  });

  it("per-scope overflow cap retains a generic disclosure for evicted and untracked scopes", () => {
    const registry = new TaskRuntimeRegistry();
    const policy = registry as unknown as {
      recordOmittedRow(scope: string, liveActionable?: boolean): void;
      omittedInteractionRows: Map<string, unknown>;
    };
    for (let index = 0; index < 65; index += 1)
      policy.recordOmittedRow(`profile-${index}`, index === 0);

    expect(policy.omittedInteractionRows.size).toBe(64);
    expect(registry.interactionInboxOverflow("profile-0")).toEqual({
      omittedRows: 0,
      mayContainUntrackedRows: true,
    });
    expect(registry.interactionInboxOverflow("profile-never-tracked")).toEqual({
      omittedRows: 0,
      mayContainUntrackedRows: true,
    });
    expect(registry.interactionInboxOverflow("profile-64")).toMatchObject({ omittedRows: 1 });
  });
});
