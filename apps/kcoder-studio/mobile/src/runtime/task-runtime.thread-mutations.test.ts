const deletionStorage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => deletionStorage.get(key) ?? null,
  setItem: async (key: string, value: string) => { deletionStorage.set(key, value); },
  multiRemove: async (keys: string[]) => { keys.forEach(key => deletionStorage.delete(key)); },
  removeItem: async (key: string) => { deletionStorage.delete(key); },
} }));
import type { JsonRecord } from "@/gateway/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteStoredThread,
  subscribeThreadMutations,
  TaskRuntime,
  taskRuntimeTestHelpers,
  threadMutationServerIdentity,
  updateThreadMetadata,
  type ThreadMutationEvent,
} from "./task-runtime";
import { publishThreadMutation } from "./task-runtime/threadDirectory";
import {
  FakeClient,
  profile,
  server,
} from "./task-runtime/fixture.test-support";

afterEach(() => {
  vi.restoreAllMocks();
  taskRuntimeTestHelpers.resetConnector();
});

describe("acknowledged thread mutations", () => {
  it("publishes a scoped event only with an exact cwd and releases subscribers", () => {
    const events: ThreadMutationEvent[] = [];
    const unsubscribe = subscribeThreadMutations((event) => events.push(event));
    const cwd = "/workspace/worktree-a";

    publishThreadMutation(profile, server, "thread-1", undefined, {
      kind: "delete",
    });
    publishThreadMutation(profile, server, "thread-1", cwd, {
      kind: "rename",
      title: "renamed",
    });

    expect(events).toEqual([
      {
        profileId: profile.id,
        profileBaseUrl: profile.baseUrl,
        serverId: server.id,
        serverConfigIdentity: threadMutationServerIdentity(server),
        threadId: "thread-1",
        cwd,
        mutation: { kind: "rename", title: "renamed" },
      },
    ]);
    expect(
      threadMutationServerIdentity({ ...server, host: "changed-target" }),
    ).not.toBe(threadMutationServerIdentity(server));

    unsubscribe();
    publishThreadMutation(profile, server, "thread-1", cwd, {
      kind: "delete",
    });
    expect(events).toHaveLength(1);
  });

  it("emits direct metadata events only after ACK and only for supplied cwd", async () => {
    const events: ThreadMutationEvent[] = [];
    const unsubscribe = subscribeThreadMutations((event) => events.push(event));
    const client = {
      close: vi.fn(),
      request: vi.fn(async () => ({})),
    };
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );

    await updateThreadMetadata(
      profile,
      server,
      "thread-1",
      { title: "renamed" },
      "/workspace/worktree-a",
    );
    await updateThreadMetadata(profile, server, "thread-1", {
      archivedAt: "2026-09-30T10:00:00Z",
    }, "/workspace/worktree-a");
    await updateThreadMetadata(
      profile,
      server,
      "thread-1",
      { archivedAt: null },
      "/workspace/worktree-a",
    );
    await updateThreadMetadata(profile, server, "thread-1", {
      archivedAt: "2026-09-30T10:00:00Z",
    });

    expect(events).toEqual([
      expect.objectContaining({
        profileId: profile.id,
        profileBaseUrl: profile.baseUrl,
        serverId: server.id,
        serverConfigIdentity: threadMutationServerIdentity(server),
        threadId: "thread-1",
        cwd: "/workspace/worktree-a",
        mutation: { kind: "rename", title: "renamed" },
      }),
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/workspace/worktree-a",
        mutation: { kind: "archive", archivedAt: "2026-09-30T10:00:00Z" },
      }),
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/workspace/worktree-a",
        mutation: { kind: "unarchive" },
      }),
    ]);

    client.request.mockRejectedValueOnce(new Error("metadata rejected"));
    await expect(
      updateThreadMetadata(
        profile,
        server,
        "thread-1",
        { title: "not acknowledged" },
        "/workspace/worktree-a",
      ),
    ).rejects.toThrow("metadata rejected");
    expect(events).toHaveLength(3);
    unsubscribe();
  });

  it("emits TaskRuntime metadata and delete mutations with its resolved thread cwd", async () => {
    const client = new FakeClient([]);
    const thread = {
      id: "thread-1",
      cwd: "/workspace/worktree-a",
      status: "idle",
    };
    client.request = vi.fn(
      async <T>(method: string, _params: JsonRecord = {}) => {
        if (method === "thread/resume") return { thread } as T;
        if (method === "thread/read") return { thread, messages: [] } as T;
        return {} as T;
      },
    ) as never;
    const events: ThreadMutationEvent[] = [];
    const unsubscribe = subscribeThreadMutations((event) => events.push(event));
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    await runtime.rename("renamed");
    await runtime.archive();
    await runtime.unarchive();
    await runtime.deleteThread();

    expect(events.map((event) => event.mutation.kind)).toEqual([
      "rename",
      "archive",
      "unarchive",
      "delete",
    ]);
    expect(events.every((event) => event.cwd === thread.cwd)).toBe(true);
    runtime.close();
    unsubscribe();
  });

  it("uses the cwd returned by thread/start instead of the requested alias", async () => {
    const client = new FakeClient([]);
    client.request = vi.fn(async (method: string, _params: JsonRecord = {}) => {
      if (method === "thread/start")
        return {
          thread: { id: "canonical-thread", cwd: "/workspace/real-path" },
        } as never;
      if (method === "turn/start") return { turn: { id: "turn-1" } } as never;
      return {} as never;
    }) as never;
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const events: ThreadMutationEvent[] = [];
    const unsubscribe = subscribeThreadMutations((event) => events.push(event));

    const runtime = await TaskRuntime.create({
      profile,
      server,
      cwd: "/workspace/requested-alias",
      prompt: "new task",
    });
    await runtime.rename("renamed");

    expect(runtime.getSnapshot().cwd).toBe("/workspace/real-path");
    expect(events).toEqual([
      expect.objectContaining({
        threadId: "canonical-thread",
        cwd: "/workspace/real-path",
        mutation: { kind: "rename", title: "renamed" },
      }),
    ]);
    runtime.close();
    unsubscribe();
  });

  it("does not broadcast TaskRuntime mutations when thread cwd was not authoritative", async () => {
    const client = new FakeClient([]);
    client.request = vi.fn(async <T>(method: string) => {
      if (method === "thread/resume")
        return {
          thread: { id: "thread-1", status: "idle" },
        } as T;
      if (method === "thread/read") return { messages: [] } as T;
      return {} as T;
    }) as never;
    const events: ThreadMutationEvent[] = [];
    const unsubscribe = subscribeThreadMutations((event) => events.push(event));
    taskRuntimeTestHelpers.setConnector(
      vi.fn(async () => client as never) as never,
    );
    const runtime = await TaskRuntime.resume({
      profile,
      server,
      threadId: "thread-1",
    });

    await runtime.rename("renamed");

    expect(events).toEqual([]);
    runtime.close();
    unsubscribe();
  });

  it("emits standalone deletion only after thread/delete ACK", async () => {
    const events: ThreadMutationEvent[] = [];
    const unsubscribe = subscribeThreadMutations((event) => events.push(event));
    const mainClient = {
      close: vi.fn(),
      request: vi.fn(async (method: string) =>
        method === "thread/read" ? { messages: [] } : {},
      ),
    };
    const registryClient = {
      close: vi.fn(),
      request: vi.fn(async () => ({})),
    };
    const connect = vi
      .fn(async () => mainClient as never)
      .mockResolvedValueOnce(mainClient as never)
      .mockResolvedValueOnce(registryClient as never);
    taskRuntimeTestHelpers.setConnector(connect as never);

    await deleteStoredThread(
      profile,
      server,
      "thread-1",
      "/workspace/worktree-a",
    );

    expect(mainClient.request).toHaveBeenCalledWith("thread/delete", {
      threadId: "thread-1",
    });
    expect(events).toEqual([
      expect.objectContaining({
        profileId: profile.id,
        profileBaseUrl: profile.baseUrl,
        serverId: server.id,
        threadId: "thread-1",
        cwd: "/workspace/worktree-a",
        mutation: { kind: "delete" },
      }),
    ]);

    unsubscribe();
  });
});
