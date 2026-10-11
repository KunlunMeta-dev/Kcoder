import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import { useTaskCommands } from "./useTaskCommands";
import { useTaskSending } from "./useTaskSending";
import {
  taskMessageQueue,
  type QueuedTaskMessage,
} from "@/runtime/task-message-queue";
import {
  TaskRuntime,
  taskRuntimeRegistry,
  taskRuntimeTestHelpers,
} from "@/runtime/task-runtime";
import type { WorkspaceFailedSubmission } from "@/storage/workspace-preferences";
import {
  FakeClient,
  profile,
  server,
} from "@/runtime/task-runtime/fixture.test-support";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    getAllKeys: async () => [],
    multiRemove: async () => {},
  },
}));

const hookHarness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
  states: [] as unknown[],
  refIndex: 0,
  stateIndex: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hookHarness.stateIndex++;
      if (!(index in hookHarness.states)) {
        hookHarness.states[index] = typeof initial === "function"
          ? (initial as () => unknown)()
          : initial;
      }
      const setState = (next: unknown) => {
        hookHarness.states[index] = typeof next === "function"
          ? (next as (previous: unknown) => unknown)(hookHarness.states[index])
          : next;
      };
      return [hookHarness.states[index], setState] as const;
    },
    useEffect: (effect: () => void | (() => void)) => {
      hookHarness.effects.push(effect);
    },
    useRef: (initial: unknown) => {
      const index = hookHarness.refIndex++;
      hookHarness.refs[index] ??= { current: initial };
      return hookHarness.refs[index];
    },
    useSyncExternalStore: (
      _subscribe: () => () => void,
      getSnapshot: () => unknown,
    ) => getSnapshot(),
  };
});

vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => {}),
  gatewaySessionExpired: vi.fn(async () => false),
}));

interface CapturedStart {
  method: string;
  params: JsonRecord;
}

function makeServerClient() {
  const client = new FakeClient([]);
  const starts: CapturedStart[] = [];
  let turnNumber = 0;
  let rejectQueuedOnce = true;
  client.supportsExperimental = (capability) =>
    capability === "sessionModes";
  client.request = vi.fn(
    async <T>(method: string, params: JsonRecord = {}): Promise<T> => {
      if (method === "thread/start")
        return {
          thread: {
            id: "thread-mobile-send-contract",
            cwd: "/workspace",
            status: "idle",
          },
        } as T;
      if (method === "thread/resume")
        return {
          thread: {
            id: "thread-mobile-send-contract",
            cwd: "/workspace",
            status: "idle",
          },
        } as T;
      if (method === "thread/read")
        return { messages: [], hasMoreBefore: false } as T;
      if (method === "turn/start") {
        starts.push({ method, params });
        // Keep the real runtime and composer hooks in this test; model the
        // app-server enum rejection at the RPC boundary without launching Rust.
        const mode = params.turnMode;
        if (
          mode !== undefined &&
          (typeof mode !== "string" ||
            !["standard", "moa", "moa-plan"].includes(mode))
        ) {
          throw new MobileRpcError(
            "unknown variant 'clientMessageId', expected one of 'standard', 'moa', 'moa-plan'",
            -32602,
            "remote",
          );
        }
        const input = params.input;
        const text =
          Array.isArray(input) &&
          input[0] &&
          typeof input[0] === "object" &&
          "text" in input[0]
            ? String(input[0].text)
            : "";
        if (text.includes("queued retry contract") && rejectQueuedOnce) {
          rejectQueuedOnce = false;
          throw new MobileRpcError(
            "temporary queued-send rejection",
            -32025,
            "remote",
          );
        }
        turnNumber += 1;
        return {
          turn: { id: `turn-${turnNumber}`, status: "completed" },
        } as T;
      }
      return {} as T;
    },
  ) as never;
  return { client, starts };
}

function contextFor(
  task: TaskRuntime,
  input: string,
  queuedMessages: readonly QueuedTaskMessage[],
  initialFailedSubmissions: readonly WorkspaceFailedSubmission[] = [],
) {
  const queue = taskMessageQueue(task);
  const inputIntentRef = { current: { value: input, revision: 0 } };
  const setInput = vi.fn((value: string) => {
    inputIntentRef.current = {
      value,
      revision: inputIntentRef.current.revision + 1,
    };
  });
  return {
    task,
    demo: false,
    onDraftChange: vi.fn(),
    initialFailedSubmissions,
    onFailedSubmissionsChange: vi.fn(),
    snapshot: task.getSnapshot(),
    messageQueue: queue,
    queuedMessages,
    input,
    setInput,
    inputIntentRef,
    mountedRef: { current: true },
    pendingAttachmentSubmissions: { current: new Map<string, number>() },
    removedPendingAttachments: { current: new Set<string>() },
    goalEditExpectationRef: { current: null },
    attachments: [],
    setAttachments: vi.fn(),
    setQueueError: vi.fn(),
    setComposerNotice: vi.fn(),
    openModelPicker: vi.fn(),
    messageInputRef: { current: null },
    sendingQueued: { current: false },
  };
}

async function resumeRuntime() {
  const { client, starts } = makeServerClient();
  taskRuntimeTestHelpers.setConnector(
    vi.fn(async () => client as never) as never,
  );
  const runtime = await TaskRuntime.resume({
    profile,
    server,
    threadId: "thread-mobile-send-contract",
  });
  return { runtime, client, starts };
}

async function createRuntime() {
  const { client, starts } = makeServerClient();
  taskRuntimeTestHelpers.setConnector(
    vi.fn(async () => client as never) as never,
  );
  const runtime = await TaskRuntime.create({
    profile,
    server,
    cwd: "/workspace",
    prompt: "first message created with the new task",
  });
  return { runtime, client, starts };
}

function renderComposerSend(context: ReturnType<typeof contextFor>) {
  hookHarness.refIndex = hookHarness.stateIndex = 0;
  return useTaskSending(
    useTaskCommands(
      context as unknown as Parameters<typeof useTaskCommands>[0],
    ),
  );
}

describe("TaskRuntime and Mobile composer send argument contract", () => {
  beforeEach(() => {
    installBrowserProfileFixture([profile]);
    hookHarness.effects = [];
    hookHarness.refs = [];
    hookHarness.states = [];
    hookHarness.refIndex = 0;
    hookHarness.stateIndex = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    taskRuntimeTestHelpers.resetConnector();
  });

  it("keeps the second direct composer send identity outside turnMode", async () => {
    const { runtime, starts } = await resumeRuntime();
    try {
      await runtime.send("first message through the existing thread");
      const context = contextFor(
        runtime,
        "second message from the composer",
        [],
      );
      const composer = renderComposerSend(context);

      await composer.submit();

      expect(starts).toHaveLength(2);
      expect(starts[1].params).toMatchObject({
        threadId: "thread-mobile-send-contract",
        input: [{ type: "text", text: "second message from the composer" }],
      });
      expect(starts[1].params.turnMode).toBeUndefined();
      expect(starts[1].params.clientMessageId).toEqual(expect.any(String));
      expect(String(starts[1].params.clientMessageId)).toMatch(/^composer-/);
    } finally {
      runtime.close();
    }
  });

  it("passes the exact TaskRuntime.create instance through registry to the second composer send", async () => {
    const { runtime, starts } = await createRuntime();
    const threadId = runtime.getSnapshot().threadId;
    try {
      taskRuntimeRegistry.put(profile.id, server.id, runtime);
      const routeRuntime = taskRuntimeRegistry.get(
        profile.id,
        server.id,
        threadId,
      );
      expect(routeRuntime).toBe(runtime);
      if (!routeRuntime) throw new Error("created task was not registered");

      const context = contextFor(
        routeRuntime,
        "second message after task creation",
        [],
      );
      const composer = renderComposerSend(context);
      await composer.submit();

      expect(starts).toHaveLength(2);
      expect(starts[1].params.input).toEqual([
        { type: "text", text: "second message after task creation" },
      ]);
      expect(starts[1].params.turnMode).toBeUndefined();
      expect(starts[1].params.clientMessageId).toEqual(expect.any(String));
      expect(String(starts[1].params.clientMessageId)).toMatch(/^composer-/);
    } finally {
      taskRuntimeRegistry.remove(profile.id, server.id, threadId);
    }
  });

  it("retries a queued message with the same id and never puts it in turnMode", async () => {
    const { runtime, starts } = await resumeRuntime();
    try {
      const queue = taskMessageQueue(runtime);
      const queued = {
        id: "queued-retry-stable-id",
        content: "queued retry contract",
        attachments: [],
        createdAt: 123,
      };
      queue.enqueue(queued);
      const base = contextFor(runtime, "", queue.getSnapshot());
      const composer = renderComposerSend(base);
      hookHarness.effects.at(-1)?.();
      await vi.waitFor(() =>
        expect(base.setQueueError).toHaveBeenCalledWith(
          expect.stringContaining("temporary queued-send rejection"),
        ),
      );
      expect(queue.first()).toEqual(queued);

      hookHarness.effects = [];
      const retryContext = contextFor(runtime, "", queue.getSnapshot());
      const retryComposer = renderComposerSend(retryContext);
      hookHarness.effects.at(-1)?.();
      await vi.waitFor(() => expect(queue.first()).toBeUndefined());

      expect(starts).toHaveLength(2);
      expect(starts.map(({ params }) => params.clientMessageId)).toEqual([
        queued.id,
        queued.id,
      ]);
      expect(starts.every(({ params }) => params.turnMode === undefined)).toBe(
        true,
      );
      expect(retryComposer.canSend).toBe(false);
    } finally {
      runtime.close();
    }
  });

  it("retries the failed card through TaskRuntime with its id in send options", async () => {
    const { runtime, starts } = await resumeRuntime();
    try {
      const id = "failed-card-stable-id";
      const context = contextFor(runtime, "", [], [
        {
          id,
          content: "failed card retry payload",
          attachments: [],
          createdAt: 456,
          outcome: "failed",
          error: "previous remote rejection",
        },
      ]);
      const composer = renderComposerSend(context);

      expect(composer.failedSubmissions).toHaveLength(1);
      await composer.retryFailedSubmission(id);

      expect(starts).toHaveLength(1);
      expect(starts[0].params.input).toEqual([
        { type: "text", text: "failed card retry payload" },
      ]);
      expect(starts[0].params.turnMode).toBeUndefined();
      expect(starts[0].params.clientMessageId).toBe(id);
      expect(
        renderComposerSend(context).failedSubmissions,
      ).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });

  it("keeps /moa as a turn mode and gives the resulting request a stable identity", async () => {
    const { runtime, starts } = await resumeRuntime();
    try {
      const context = contextFor(runtime, "/moa inspect the migration", []);
      const commands = useTaskCommands(
        context as unknown as Parameters<typeof useTaskCommands>[0],
      );

      await expect(commands.executeSlashCommand(context.input)).resolves.toBe(
        true,
      );

      expect(starts).toHaveLength(1);
      expect(starts[0].params.turnMode).toBe("moa");
      expect(starts[0].params.clientMessageId).toEqual(expect.any(String));
      expect(typeof starts[0].params.clientMessageId).toBe("string");
    } finally {
      runtime.close();
    }
  });
});
