import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskMessageQueue } from "@/runtime/task-message-queue";
import type { WorkspaceViewState } from "@/storage/workspace-preferences";
import { useTaskSending } from "./useTaskSending";

const asyncStorageHarness = vi.hoisted(() => ({
  values: new Map<string, string>(),
  beforeSetItem: undefined as
    | ((key: string, value: string) => Promise<void>)
    | undefined,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStorageHarness.values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      await asyncStorageHarness.beforeSetItem?.(key, value);
      asyncStorageHarness.values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      asyncStorageHarness.values.delete(key);
    }),
  },
}));

import {
  loadWorkspaceState,
  saveWorkspaceState,
} from "@/storage/workspace-preferences";
import { useTaskAgentState } from "./useTaskAgentState";
vi.mock("@/storage/secure", () => ({
  getSecureValue: async (key: string) => key === "kcoder-studio-mobile.gateway-profiles.v2" ? JSON.stringify({ profiles: [{ id: "review-profile", baseUrl: "" }] }) : null,
  setSecureValue: async () => {},
  removeSecureValue: async () => {},
}));

const captured = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      captured.effects.push(effect);
    },
    useMemo: (factory: () => unknown) => factory(),
    useRef: (initial: unknown) => {
      const index = captured.refIndex++;
      captured.refs[index] ??= { current: initial };
      return captured.refs[index];
    },
    useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, vi.fn()],
    useSyncExternalStore: (
      _subscribe: () => () => void,
      getSnapshot: () => unknown,
    ) => getSnapshot(),
  };
});

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  FlatList: class FlatList {},
  Keyboard: { dismiss: vi.fn() },
  TextInput: class TextInput {},
}));

vi.mock("@/components/use-modal-focus-trap", () => ({
  useModalFocusTrap: vi.fn(() => null),
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderSendingHook(context: Parameters<typeof useTaskSending>[0]) {
  captured.refIndex = 0;
  return useTaskSending(context);
}

function stagedAttachment(path: string) {
  return {
    filename: `${path}.txt`,
    mimeType: "text/plain",
    fileSize: 1,
    path,
    localPreviewUri: `blob:${path}`,
    ownsLocalPreviewUri: true,
  };
}

function baseContext(overrides: Record<string, unknown> = {}) {
  const inputIntentRef = { current: { value: String(overrides.input ?? ""), revision: 0 } };
  const task = {
    request: vi.fn(async () => ({})),
    send: vi.fn(async () => {}),
    getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
    isDisposed: vi.fn(() => false),
  };
  const messageQueue = new TaskMessageQueue();
  const context = {
    task,
    demo: false,
    snapshot: {
      threadId: "thread-queue-review",
      connected: true,
      running: true,
      interaction: null,
      archivedAt: null,
      sendAcceptanceUnknown: false,
    },
    messageQueue,
    queuedMessages: messageQueue.getSnapshot(),
    input: "",
    inputIntentRef,
    inputRevisionRef: { current: 0 },
    latestInputRef: { current: String(overrides.input ?? "") },
    pendingAttachmentSubmissions: { current: new Map<string, number>() },
    removedPendingAttachments: { current: new Set<string>() },
    setInput: vi.fn((next: string | ((value: string) => string)) => {
      const value = typeof next === "function" ? next(inputIntentRef.current.value) : next;
      inputIntentRef.current = { value, revision: inputIntentRef.current.revision + 1 };
    }),
    goalEditExpectationRef: { current: null },
    attachments: [],
    setAttachments: vi.fn(),
    mountedRef: { current: true },
    setQueueError: vi.fn(),
    sendingQueued: { current: false },
    executeSlashCommand: vi.fn(async () => false),
    ...overrides,
  };
  return context as unknown as Parameters<typeof useTaskSending>[0];
}

describe("useTaskSending durable queue staging review", () => {
  beforeEach(() => {
    captured.effects = [];
    captured.refs = [];
    captured.refIndex = 0;
    asyncStorageHarness.values.clear();
    asyncStorageHarness.beforeSetItem = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not dispatch when queue commit persistence is absent", async () => {
    const persistedFailed: WorkspaceViewState["failedSubmissions"] = [];
    const context = baseContext({
      input: "must remain recoverable",
      onFailedSubmissionsChange: vi.fn((value) => {
        persistedFailed.splice(0, persistedFailed.length, ...(value ?? []));
      }),
    });

    await renderSendingHook(context).submit();

    const queue = context.messageQueue as TaskMessageQueue;
    // A missing commit writer rejects and removes the in-memory staged queue row;
    // the separately persisted failed submission remains the recovery path.
    expect(queue.getSnapshot()).toHaveLength(0);
    expect(queue.first()).toBeUndefined();
    expect(persistedFailed).toHaveLength(1);

    const idleContext = {
      ...context,
      snapshot: { ...context.snapshot, running: false },
      queuedMessages: queue.getSnapshot(),
    } as Parameters<typeof useTaskSending>[0];
    const idleSending = renderSendingHook(idleContext);
    captured.effects.at(-1)?.();
    await Promise.resolve();

    expect(idleSending.failedSubmissions).toHaveLength(1);
    expect(context.task.send).not.toHaveBeenCalled();
  });

  it("serializes inverse attachment-retain completions without losing either staged message", async () => {
    const retainA = deferred();
    const retainB = deferred();
    const firstCommit = deferred();
    const persisted: {
      queuedMessages: WorkspaceViewState["queuedMessages"];
      failedSubmissions: WorkspaceViewState["failedSubmissions"];
    } = { queuedMessages: [], failedSubmissions: [] };
    let queueWriteTail: Promise<void> = Promise.resolve();
    const commitSnapshots: Array<{
      queuedMessages: WorkspaceViewState["queuedMessages"];
      failedSubmissions: WorkspaceViewState["failedSubmissions"];
    }> = [];
    const onQueueCommit = vi.fn(
      (value: {
        queuedMessages: WorkspaceViewState["queuedMessages"];
        failedSubmissions: WorkspaceViewState["failedSubmissions"];
      }) => {
        const index = commitSnapshots.length;
        const snapshot = {
          queuedMessages: value.queuedMessages?.map((item) => ({ ...item })),
          failedSubmissions: value.failedSubmissions?.map((item) => ({ ...item })),
        };
        commitSnapshots.push(snapshot);
        const write = queueWriteTail.then(async () => {
          if (index === 0) await firstCommit.promise;
          persisted.queuedMessages = snapshot.queuedMessages;
          persisted.failedSubmissions = snapshot.failedSubmissions;
        });
        queueWriteTail = write;
        return write;
      },
    );
    const context = baseContext({
      task: {
        request: vi.fn((_method: string, params: { paths?: string[] }) =>
          params.paths?.[0]?.includes("attachment-a")
            ? retainA.promise
            : retainB.promise,
        ),
        send: vi.fn(async () => {}),
        getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
        isDisposed: vi.fn(() => false),
      },
      onQueueCommit,
      onFailedSubmissionsChange: vi.fn((value) => {
        persisted.failedSubmissions = value;
      }),
    });
    const queue = context.messageQueue as TaskMessageQueue;

    const submitA = renderSendingHook({
      ...context,
      input: "A",
      attachments: [stagedAttachment("task/attachment-a")],
    } as Parameters<typeof useTaskSending>[0]).submit();
    const submitB = renderSendingHook({
      ...context,
      input: "B",
      attachments: [stagedAttachment("task/attachment-b")],
    } as Parameters<typeof useTaskSending>[0]).submit();
    await vi.waitFor(() => expect(context.task.request).toHaveBeenCalledTimes(2));

    // B's retain finishes first, and its durable commit remains pending while A finishes.
    retainB.resolve();
    await vi.waitFor(() => expect(onQueueCommit).toHaveBeenCalledTimes(1));
    retainA.resolve();
    await Promise.resolve();
    firstCommit.resolve();
    await Promise.all([submitA, submitB]);

    expect(commitSnapshots.length).toBe(2);
    expect(persisted.queuedMessages?.map((item) => item.content)).toEqual(["A", "B"]);
    expect(queue.getSnapshot().map((item) => item.content)).toEqual(["A", "B"]);
    expect(queue.getSnapshot().every((item) => item.staging !== true)).toBe(true);
  });

  it("keeps a failed durable commit only in recovery state and never auto-sends it after reload", async () => {
    const persisted: {
      queuedMessages: WorkspaceViewState["queuedMessages"];
      failedSubmissions: WorkspaceViewState["failedSubmissions"];
    } = { queuedMessages: [], failedSubmissions: [] };
    const context = baseContext({
      input: "must not become dispatchable",
      onQueueCommit: vi.fn(async () => {
        throw new Error("controlled queue storage failure");
      }),
      onFailedSubmissionsChange: vi.fn((value) => {
        persisted.failedSubmissions = value;
      }),
    });

    await renderSendingHook(context).submit();

    const liveQueue = context.messageQueue as TaskMessageQueue;
    expect(liveQueue.getSnapshot()).toHaveLength(0);
    expect(persisted.queuedMessages).toEqual([]);
    expect(persisted.failedSubmissions).toEqual([
      expect.objectContaining({
        content: "must not become dispatchable",
        outcome: "failed",
      }),
    ]);

    const restoredQueue = new TaskMessageQueue();
    restoredQueue.replace(persisted.queuedMessages ?? []);
    const restoredTask = {
      request: vi.fn(async () => ({})),
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
    };
    const restoredContext = baseContext({
      task: restoredTask,
      snapshot: {
        threadId: "thread-queue-review",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: restoredQueue,
      queuedMessages: restoredQueue.getSnapshot(),
      initialFailedSubmissions: persisted.failedSubmissions,
      onFailedSubmissionsChange: vi.fn(),
      onQueueCommit: vi.fn(),
    });
    const restoredSending = renderSendingHook(restoredContext);
    captured.effects.at(-1)?.();
    await Promise.resolve();

    expect(restoredSending.failedSubmissions).toEqual([
      expect.objectContaining({ outcome: "failed" }),
    ]);
    expect(restoredTask.send).not.toHaveBeenCalled();
  });

  it("does not reintroduce a committed failed card from an older overlapping snapshot", async () => {
    const firstCommitStarted = deferred();
    const allowFirstCommit = deferred();
    let pausedFirstCommit = false;
    asyncStorageHarness.beforeSetItem = async (_key, value) => {
      const next = JSON.parse(value) as WorkspaceViewState;
      const queuedA = next.queuedMessages?.some((item) => item.content === "queued A");
      const failedA = next.failedSubmissions?.some((item) => item.content === "queued A");
      if (queuedA && !failedA && !pausedFirstCommit) {
        pausedFirstCommit = true;
        firstCommitStarted.resolve();
        await allowFirstCommit.promise;
      }
    };
    const threadId = "thread-real-storage-overlap-review";
    const keyArgs = ["review-profile", "review-server", threadId] as const;
    const persistQueueCommit = (value: Pick<WorkspaceViewState, "queuedMessages" | "failedSubmissions">) =>
      saveWorkspaceState(...keyArgs, value);
    const persistFailed = (failedSubmissions: WorkspaceViewState["failedSubmissions"]) =>
      saveWorkspaceState(...keyArgs, { failedSubmissions });
    const retainB = deferred();
    const task = {
      request: vi.fn(async () => retainB.promise),
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
    };
    const base = baseContext({
      task,
      snapshot: {
        threadId,
        connected: true,
        running: true,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      onQueueCommit: persistQueueCommit,
      onFailedSubmissionsChange: persistFailed,
    });
    const submitA = renderSendingHook({
      ...base,
      input: "queued A",
    } as Parameters<typeof useTaskSending>[0]).submit();
    await firstCommitStarted.promise;

    const submitB = renderSendingHook({
      ...base,
      input: "queued B",
      attachments: [stagedAttachment("task/retain-B-before-commit")],
    } as Parameters<typeof useTaskSending>[0]).submit();
    allowFirstCommit.resolve();
    await vi.waitFor(() => expect(task.request).toHaveBeenCalledTimes(1));
    await submitA;

    // B has durably written its earlier complete failed-submission snapshot and
    // is still awaiting attachment retention. Simulate a crash at this boundary.
    const crashBoundaryState = await loadWorkspaceState(...keyArgs);
    retainB.resolve();
    await submitB;

    expect(crashBoundaryState.queuedMessages?.map((item) => item.content)).toContain("queued A");
    expect(crashBoundaryState.failedSubmissions?.some((item) => item.content === "queued A")).toBe(false);
  });

  it("does not let takeFirst consume a staged queue item", () => {
    const queue = new TaskMessageQueue();
    queue.enqueue({
      id: "staging",
      content: "staging",
      attachments: [],
      createdAt: 1,
      staging: true,
    });

    expect(queue.first()).toBeUndefined();
    expect(queue.takeFirst()).toBeUndefined();
    expect(queue.getSnapshot()).toEqual([
      expect.objectContaining({ id: "staging", staging: true }),
    ]);
  });

  it("keeps a staging row and its attachment while retain is pending", async () => {
    const retain = deferred();
    const task = {
      request: vi.fn((method: string) =>
        method === "gateway/attachments/retain" ? retain.promise : Promise.resolve({}),
      ),
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
    };
    const context = baseContext({
      task,
      input: "queued with attachment",
      attachments: [stagedAttachment("task/staging-removal-race")],
      onQueueCommit: vi.fn(async () => {}),
      onFailedSubmissionsChange: vi.fn(async () => {}),
    });
    const sending = renderSendingHook(context);
    const submit = sending.submit();
    await vi.waitFor(() =>
      expect(task.request).toHaveBeenCalledWith("gateway/attachments/retain", {
        paths: ["task/staging-removal-race"],
        threadId: "thread-queue-review",
      }),
    );
    const staged = (context.messageQueue as TaskMessageQueue).getSnapshot()[0];
    expect(staged.staging).toBe(true);

    sending.removeQueuedMessage(staged.id);
    expect((context.messageQueue as TaskMessageQueue).getSnapshot()).toContainEqual(
      expect.objectContaining({ id: staged.id, staging: true }),
    );
    expect(task.request).not.toHaveBeenCalledWith("attachment/delete", {
      path: "task/staging-removal-race",
    });
    retain.resolve();
    await submit;

    expect(task.request).not.toHaveBeenCalledWith("attachment/delete", {
      path: "task/staging-removal-race",
    });
    expect((context.messageQueue as TaskMessageQueue).getSnapshot()).toContainEqual(
      expect.objectContaining({ id: staged.id, staging: false }),
    );
    expect(context.onQueueCommit).toHaveBeenCalledTimes(1);
  });

  it("re-reads the current queue when an old AgentState effect runs after a durable commit", async () => {
    const commitStarted = deferred();
    const allowCommit = deferred();
    let paused = false;
    asyncStorageHarness.beforeSetItem = async (_key, value) => {
      const next = JSON.parse(value) as WorkspaceViewState;
      if (
        next.queuedMessages?.some((item) => item.content === "durable queue") &&
        !paused
      ) {
        paused = true;
        commitStarted.resolve();
        await allowCommit.promise;
      }
    };
    const keyArgs = ["review-profile", "review-server", "thread-stale-queue-projection"] as const;
    const task = {
      subscribe: vi.fn(() => vi.fn()),
      getSnapshot: vi.fn(() => ({ messages: [] })),
      request: vi.fn(async () => ({})),
    };
    const state = useTaskAgentState({
      task,
      profile: undefined,
      server: undefined,
      bottomInset: 0,
      demo: false,
      initialDraft: undefined,
      initialQueuedMessages: undefined,
      initialFailedSubmissions: undefined,
      onDraftChange: undefined,
      onQueuedMessagesChange: (queuedMessages: WorkspaceViewState["queuedMessages"]) => saveWorkspaceState(...keyArgs, { queuedMessages }),
      onFailedSubmissionsChange: (failedSubmissions: WorkspaceViewState["failedSubmissions"]) => saveWorkspaceState(...keyArgs, { failedSubmissions }),
      onQueueCommit: (value: Pick<WorkspaceViewState, "queuedMessages" | "failedSubmissions">) => saveWorkspaceState(...keyArgs, value),
      onTurnPreferencesChange: undefined,
      onOpenFile: undefined,
      onOpenChanges: undefined,
    } as unknown as Parameters<typeof useTaskAgentState>[0]);
    const delayedQueueEffect = captured.effects.find((effect) =>
      effect.toString().includes("queueHydrated.current = true"),
    );
    expect(delayedQueueEffect).toBeTypeOf("function");
    if (!delayedQueueEffect) throw new Error("AgentState queue persistence effect was not captured");
    const queue = state.messageQueue;
    queue.enqueue({
      id: "queued-durable-queue-id",
      content: "durable queue",
      attachments: [],
      createdAt: 1,
      staging: true,
    });
    const commit = queue.commitReady("queued-durable-queue-id", async (messages) => {
      await saveWorkspaceState(...keyArgs, { queuedMessages: messages, failedSubmissions: [] });
    });
    const commitBoundary = await Promise.race([
      commitStarted.promise.then(() => "storage-write-paused"),
      commit.then(() => "commit-finished", (error) => `commit-rejected:${String(error)}`),
    ]);
    expect(commitBoundary).toBe("storage-write-paused");

    // The effect closure captured an empty queue from an earlier render. It is
    // invoked while the newer durable commit is paused in AsyncStorage.setItem.
    delayedQueueEffect();
    allowCommit.resolve();
    await commit;
    await vi.waitFor(async () => {
      const persisted = await loadWorkspaceState(...keyArgs);
      expect(persisted.queuedMessages?.some((item) => item.content === "durable queue")).toBe(true);
    });

    const persisted = await loadWorkspaceState(...keyArgs);
    expect(persisted.queuedMessages?.map((item) => item.content)).toEqual(["durable queue"]);
  });

  it("does not restore an old draft over a user edit that was subsequently cleared", () => {
    const task = {
      subscribe: vi.fn(() => vi.fn()),
      getSnapshot: vi.fn(() => ({ messages: [] })),
      request: vi.fn(async () => ({})),
    };
    const baseProps = {
      task,
      profile: undefined,
      server: undefined,
      bottomInset: 0,
      demo: false,
      initialDraft: undefined,
      initialQueuedMessages: undefined,
      initialFailedSubmissions: undefined,
      onDraftChange: undefined,
      onQueuedMessagesChange: undefined,
      onFailedSubmissionsChange: undefined,
      onQueueCommit: undefined,
      onTurnPreferencesChange: undefined,
      onOpenFile: undefined,
      onOpenChanges: undefined,
    } as unknown as Parameters<typeof useTaskAgentState>[0];
    captured.refs = [];
    captured.refIndex = 0;
    captured.effects = [];
    const initial = useTaskAgentState(baseProps);
    initial.setInput("temporary user text");
    initial.setInput("");
    expect(initial.inputIntentRef.current).toEqual({ value: "", revision: 2 });

    captured.refIndex = 0;
    const restored = useTaskAgentState({ ...baseProps, initialDraft: "stale saved draft" });
    const hydrationEffect = captured.effects.findLast((effect) =>
      effect.toString().includes("draftHydrated.current = true"),
    );
    expect(hydrationEffect).toBeTypeOf("function");
    if (!hydrationEffect) throw new Error("draft hydration effect was not captured");
    hydrationEffect();

    expect(restored.inputIntentRef.current).toEqual({ value: "", revision: 2 });
  });
});
