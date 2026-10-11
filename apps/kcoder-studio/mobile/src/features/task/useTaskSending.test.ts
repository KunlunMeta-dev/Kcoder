import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturedEffects = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, vi.fn()],
    useEffect: (effect: () => void | (() => void)) => {
      capturedEffects.effects.push(effect);
    },
    useRef: (initial: unknown) => {
      const index = capturedEffects.refIndex++;
      capturedEffects.refs[index] ??= { current: initial };
      return capturedEffects.refs[index];
    },
    useSyncExternalStore: (
      _subscribe: () => () => void,
      getSnapshot: () => unknown,
    ) => getSnapshot(),
  };
});

vi.mock("./attachmentPreparation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attachmentPreparation")>();
  return {
    ...actual,
    releaseLocalAttachmentPreview: vi.fn(actual.releaseLocalAttachmentPreview),
  };
});
import type { JsonRecord } from "@/gateway/rpc";
import { useTaskSending } from "./useTaskSending";
import { releaseLocalAttachmentPreview } from "./attachmentPreparation";
const wrappedInputSetters = new WeakSet<object>();
import { TaskMessageQueue } from "@/runtime/task-message-queue";
import { MAX_QUEUED_TASK_MESSAGES } from "@/protocol/task-message-limits";

function renderSendingHook(context: Parameters<typeof useTaskSending>[0]) {
  capturedEffects.refIndex = 0;
  context.inputIntentRef ??= { current: { value: context.input, revision: 0 } };
  context.task.isDisposed ??= () => false;
  context.mountedRef ??= { current: true };
  context.task.request ??= vi.fn(async () => undefined) as typeof context.task.request;
  context.pendingAttachmentSubmissions ??= { current: new Map() };
  context.removedPendingAttachments ??= { current: new Set() };
  context.messageQueue.getSnapshot ??= () => context.queuedMessages;
  if (!wrappedInputSetters.has(context.setInput)) {
    const originalSetInput = context.setInput;
    const intent = context.inputIntentRef;
    context.setInput = (value) => {
      const next = typeof value === "function" ? value(intent.current.value) : value;
      intent.current = { value: next, revision: intent.current.revision + 1 };
      originalSetInput(next);
    };
    wrappedInputSetters.add(context.setInput);
  }
  return useTaskSending(context);
}

describe("useTaskSending queue delivery", () => {
  beforeEach(() => {
    capturedEffects.effects = [];
    capturedEffects.refs = [];
    capturedEffects.refIndex = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the persisted queued-message id for turn-start receipt recovery", async () => {
    const queued = {
      id: "queued-message-stable-id",
      content: "send this queued text",
      attachments: [],
      createdAt: 123,
    };
    const messageQueue = {
      persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(() => queued),
      remove: vi.fn(() => queued),
    };
    const task = {
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
    };
    const context = {
      task,
      demo: false,
      onDraftChange: undefined,
      snapshot: {
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
      },
      messageQueue,
      onQueueCommit: vi.fn(async () => {}),
      queuedMessages: [queued],
      input: "",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [],
      setAttachments: vi.fn(),
      mountedRef: { current: true },
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    renderSendingHook(context);
    const drainQueue = capturedEffects.effects.at(-1);
    expect(drainQueue).toBeTypeOf("function");
    if (!drainQueue) throw new Error("queue drain effect was not registered");
    drainQueue();
    await vi.waitFor(() =>
      expect(messageQueue.remove).toHaveBeenCalledWith(queued.id),
    );

    expect(task.send).toHaveBeenCalledWith(
      queued.content,
      queued.attachments,
      undefined,
      { clientMessageId: queued.id },
    );
  });

  it("keeps the queued id while turn-start acceptance is unknown", async () => {
    const queued = {
      id: "queued-message-uncertain-id",
      content: "send this queued text",
      attachments: [],
      createdAt: 123,
    };
    const liveSnapshot = { sendAcceptanceUnknown: false };
    const messageQueue = {
      persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(() => queued),
      remove: vi.fn(() => queued),
    };
    const task = {
      send: vi.fn(async () => {
        liveSnapshot.sendAcceptanceUnknown = true;
      }),
      getSnapshot: vi.fn(() => liveSnapshot),
    };
    const context = {
      task,
      demo: false,
      onDraftChange: undefined,
      snapshot: {
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue,
      onQueueCommit: vi.fn(async () => {}),
      queuedMessages: [queued],
      input: "",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [],
      setAttachments: vi.fn(),
      mountedRef: { current: true },
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    renderSendingHook(context);
    capturedEffects.effects.at(-1)?.();
    await vi.waitFor(() => expect(task.send).toHaveBeenCalledTimes(1));
    expect(messageQueue.remove).not.toHaveBeenCalled();

    renderSendingHook({
      ...context,
      snapshot: { ...context.snapshot, sendAcceptanceUnknown: true },
    });
    capturedEffects.effects.at(-1)?.();
    expect(task.send).toHaveBeenCalledTimes(1);
    expect(messageQueue.remove).not.toHaveBeenCalled();
  });

  it("keeps rejected A beside draft B and retries A without changing B", async () => {
    const attachmentA = {
      filename: "a.txt",
      mimeType: "text/plain",
      fileSize: 1,
      path: "task/a.txt",
      localPreviewUri: "blob:a",
      ownsLocalPreviewUri: true,
    };
    const attachmentB = {
      filename: "b.txt",
      mimeType: "text/plain",
      fileSize: 1,
      path: "task/b.txt",
      localPreviewUri: "blob:b",
      ownsLocalPreviewUri: true,
    };
    let rejectFirstSend!: (value: Error) => void;
    const task = {
      send: vi.fn(() => {
        if (task.send.mock.calls.length === 1) {
          return new Promise<void>((_resolve, reject) => {
            rejectFirstSend = reject;
          });
        }
        return Promise.resolve();
      }),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
      request: vi.fn(async () => ({})),
    };
    const setInput = vi.fn();
    const setAttachments = vi.fn();
    const onDraftChange = vi.fn();
    const context = {
      task,
      demo: false,
      onDraftChange,
      snapshot: {
        threadId: "thread-A",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: {
        persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(),
        remove: vi.fn(),
      },
      queuedMessages: [],
      input: "TASK_FLOW_SEND_A_PENDING_REJECT",
      setInput,
      goalEditExpectationRef: { current: null },
      attachments: [attachmentA],
      setAttachments,
      mountedRef: { current: true },
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    const submitA = renderSendingHook(context).submit;
    const pendingA = submitA();
    await vi.waitFor(() => expect(task.send).toHaveBeenCalledTimes(1));

    const contextWithB = {
      ...context,
      input: "TASK_FLOW_DRAFT_B_MUST_SURVIVE",
      attachments: [attachmentB],
    };
    const whileAPending = renderSendingHook(contextWithB);
    expect(whileAPending.failedSubmissions).toEqual([
      expect.objectContaining({
        content: "TASK_FLOW_SEND_A_PENDING_REJECT",
        outcome: "unknown",
        retrying: true,
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 350));
    onDraftChange("TASK_FLOW_DRAFT_B_MUST_SURVIVE");

    rejectFirstSend(new Error("remote turn/start rejection"));
    await pendingA;

    const afterARejected = renderSendingHook(contextWithB);
    expect(afterARejected.input).toBe("TASK_FLOW_DRAFT_B_MUST_SURVIVE");
    expect(afterARejected.failedSubmissions).toEqual([
      expect.objectContaining({
        content: "TASK_FLOW_SEND_A_PENDING_REJECT",
        attachments: [attachmentA],
        outcome: "failed",
      }),
    ]);
    expect(setInput).toHaveBeenCalledTimes(1);
    expect(setInput).toHaveBeenCalledWith("");
    expect(setInput).not.toHaveBeenCalledWith(
      "TASK_FLOW_SEND_A_PENDING_REJECT",
    );
    expect(setAttachments).toHaveBeenCalledTimes(1);
    expect(setAttachments.mock.calls[0]?.[0]).toBeTypeOf("function");
    const applyLatestAttachmentUpdate = setAttachments.mock.calls[0]![0] as (
      current: typeof context.attachments,
    ) => typeof context.attachments;
    // React may apply the captured updater after B is staged.
    expect(applyLatestAttachmentUpdate([attachmentA, attachmentB])).toEqual([attachmentB]);
    expect(onDraftChange.mock.calls).toEqual([
      [undefined],
      ["TASK_FLOW_DRAFT_B_MUST_SURVIVE"],
    ]);

    const failed = afterARejected.failedSubmissions[0];
    await afterARejected.retryFailedSubmission(failed.id);
    const afterRetry = renderSendingHook(contextWithB);

    expect(task.send).toHaveBeenNthCalledWith(
      1,
      "TASK_FLOW_SEND_A_PENDING_REJECT",
      [
        {
          filename: "a.txt",
          mimeType: "text/plain",
          fileSize: 1,
          path: "task/a.txt",
        },
      ],
      undefined,
      { clientMessageId: failed.id },
    );
    expect(task.send).toHaveBeenNthCalledWith(
      2,
      "TASK_FLOW_SEND_A_PENDING_REJECT",
      [
        {
          filename: "a.txt",
          mimeType: "text/plain",
          fileSize: 1,
          path: "task/a.txt",
        },
      ],
      undefined,
      { clientMessageId: failed.id },
    );
    expect(afterRetry.input).toBe("TASK_FLOW_DRAFT_B_MUST_SURVIVE");
    expect(afterRetry.attachments).toEqual([attachmentB]);
    expect(afterRetry.failedSubmissions).toHaveLength(0);
  });

  it("keeps failed drafts isolated to their TaskRuntime owner", async () => {
    const taskA = {
      send: vi.fn(async () => {
        throw new Error("remote rejection");
      }),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
    };
    const base = {
      demo: false,
      onDraftChange: undefined,
      snapshot: {
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: { persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(), remove: vi.fn() },
      queuedMessages: [],
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [],
      setAttachments: vi.fn(),
      mountedRef: { current: true },
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    };
    const contextA = {
      ...base,
      task: taskA,
      input: "A belongs to task A",
    } as unknown as Parameters<typeof useTaskSending>[0];
    await renderSendingHook(contextA).submit();
    expect(renderSendingHook(contextA).failedSubmissions).toHaveLength(1);

    const taskB = {
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
    };
    const contextB = {
      ...contextA,
      task: taskB,
      input: "draft for task B",
    } as unknown as Parameters<typeof useTaskSending>[0];
    expect(renderSendingHook(contextB).failedSubmissions).toHaveLength(0);
  });

  it("does not clear a newer persisted draft when a pending send succeeds", async () => {
    const persistedWorkspace: {
      composerDraft?: string;
      failedSubmissions?: readonly unknown[];
    } = {};
    let resolveSend!: () => void;
    const task = {
      send: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSend = resolve;
          }),
      ),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
    };
    const onDraftChange = vi.fn((value: string | undefined) => {
      persistedWorkspace.composerDraft = value;
    });
    const onFailedSubmissionsChange = vi.fn(
      (value: readonly unknown[] | undefined) => {
        persistedWorkspace.failedSubmissions = value;
      },
    );
    const context = {
      task,
      demo: false,
      onDraftChange,
      onFailedSubmissionsChange,
      snapshot: {
        threadId: "thread-A",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: { persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(), remove: vi.fn() },
      queuedMessages: [],
      input: "send-A",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [],
      setAttachments: vi.fn(),
      mountedRef: { current: true },
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    const pendingSend = renderSendingHook(context).submit();
    await vi.waitFor(() => expect(task.send).toHaveBeenCalledTimes(1));
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenCalledWith(undefined);

    await new Promise((resolve) => setTimeout(resolve, 350));
    onDraftChange("draft-B-persisted-after-debounce");
    resolveSend();
    await pendingSend;

    expect(onDraftChange.mock.calls).toEqual([
      [undefined],
      ["draft-B-persisted-after-debounce"],
    ]);
    expect(persistedWorkspace.composerDraft).toBe(
      "draft-B-persisted-after-debounce",
    );
    expect(persistedWorkspace.failedSubmissions).toBeUndefined();
  });

  it("does not clear B after attachment retention finishes for queued A", async () => {
    let resolveRetain!: () => void;
    const attachmentA = {
      filename: "queued-a.txt",
      mimeType: "text/plain",
      fileSize: 1,
      path: "task/queued-a.txt",
      localPreviewUri: "blob:queued-a",
      ownsLocalPreviewUri: true,
    };
    const attachmentB = {
      filename: "draft-b.txt",
      mimeType: "text/plain",
      fileSize: 1,
      path: "task/draft-b.txt",
      localPreviewUri: "blob:draft-b",
      ownsLocalPreviewUri: true,
    };
    const task = {
      request: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRetain = resolve;
          }),
      ),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
    };
    const setInput = vi.fn();
    const setAttachments = vi.fn();
    const onDraftChange = vi.fn();
    const messageQueue = new TaskMessageQueue();
    vi.spyOn(messageQueue, "enqueue");
    const context = {
      task,
      demo: false,
      onDraftChange,
      snapshot: {
        threadId: "thread-A",
        connected: true,
        running: true,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue,
      onQueueCommit: vi.fn(async () => {}),
      queuedMessages: [],
      input: "queued-A",
      setInput,
      goalEditExpectationRef: { current: null },
      attachments: [attachmentA],
      setAttachments,
      mountedRef: { current: true },
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    const pendingQueue = renderSendingHook(context).submit();
    await vi.waitFor(() => expect(task.request).toHaveBeenCalledTimes(1));
    expect(setInput).toHaveBeenCalledWith("");
    expect(setAttachments.mock.calls[0]?.[0]).toBeTypeOf("function");
    const applyLatestAttachmentUpdate = setAttachments.mock.calls[0]![0] as (
      current: typeof context.attachments,
    ) => typeof context.attachments;
    // React may apply the captured updater after B is staged.
    expect(applyLatestAttachmentUpdate([attachmentA, attachmentB])).toEqual([attachmentB]);

    await new Promise((resolve) => setTimeout(resolve, 350));
    onDraftChange("draft-B-persisted-after-debounce");
    resolveRetain();
    await pendingQueue;

    expect(messageQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ content: "queued-A" }),
    );
    expect(setInput).toHaveBeenCalledTimes(1);
    expect(setAttachments).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls).toEqual([
      [undefined],
      ["draft-B-persisted-after-debounce"],
    ]);
  });

  it("lets users dismiss only the local hint while acceptance is unknown", async () => {
    const attachment = {
      filename: "uncertain.txt",
      mimeType: "text/plain",
      fileSize: 1,
      path: "task/uncertain.txt",
      localPreviewUri: "blob:uncertain",
      ownsLocalPreviewUri: true,
    };
    const task = {
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({
        sendAcceptanceUnknown: true,
        error: "receipt pending",
      })),
      isDisposed: vi.fn(() => false),
      request: vi.fn(async () => ({})),
    };
    const context = {
      task,
      demo: false,
      onDraftChange: undefined,
      snapshot: {
        threadId: "thread-unknown",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: { persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(), remove: vi.fn() },
      queuedMessages: [],
      input: "uncertain send",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [attachment],
      setAttachments: vi.fn(),
      mountedRef: { current: true },
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    await renderSendingHook(context).submit();
    const current = renderSendingHook(context);
    const uncertain = current.failedSubmissions[0];
    expect(uncertain.outcome).toBe("unknown");

    current.removeFailedSubmissionAttachment(uncertain.id, attachment.path);
    current.dismissFailedSubmission(uncertain.id);
    await vi.waitFor(() =>
      expect(renderSendingHook(context).failedSubmissions).toHaveLength(0),
    );
    const afterBlockedMutations = renderSendingHook(context);
    expect(afterBlockedMutations.failedSubmissions).toHaveLength(0);
    expect(task.request).toHaveBeenCalledWith("gateway/attachments/retain", {
      paths: [attachment.path],
      threadId: context.snapshot.threadId,
    });
    expect(task.request).not.toHaveBeenCalledWith("attachment/delete", {
      path: attachment.path,
    });
  });

  it("does not delete attachments while a manual retry is pending", async () => {
    vi.mocked(releaseLocalAttachmentPreview).mockClear();
    const attachment = {
      filename: "retrying.txt",
      mimeType: "text/plain",
      fileSize: 1,
      path: "task/retrying.txt",
      localPreviewUri: "blob:retrying",
      ownsLocalPreviewUri: true,
    };
    let resolveRetry!: () => void;
    const task = {
      send: vi.fn(() => {
        if (task.send.mock.calls.length === 1)
          return Promise.reject(new Error("initial rejection"));
        return new Promise<void>((resolve) => {
          resolveRetry = resolve;
        });
      }),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
      request: vi.fn(async (_method: string, _params: JsonRecord) => ({})),
    };
    const context = {
      task,
      demo: false,
      onDraftChange: undefined,
      snapshot: {
        threadId: "thread-retry",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: { persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(), remove: vi.fn() },
      queuedMessages: [],
      input: "retry me",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [attachment],
      setAttachments: vi.fn(),
      mountedRef: { current: true },
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    await renderSendingHook(context).submit();
    const failedDraft = renderSendingHook(context).failedSubmissions[0];
    const retryPending = renderSendingHook(context).retryFailedSubmission(
      failedDraft.id,
    );
    await vi.waitFor(() => expect(task.send).toHaveBeenCalledTimes(2));
    const retrying = renderSendingHook(context).failedSubmissions[0];
    expect(retrying.retrying).toBe(true);

    renderSendingHook(context).removeFailedSubmissionAttachment(
      failedDraft.id,
      attachment.path,
    );
    renderSendingHook(context).dismissFailedSubmission(failedDraft.id);

    expect(renderSendingHook(context).failedSubmissions[0].attachments).toEqual(
      [attachment],
    );
    expect(task.request).toHaveBeenCalledTimes(2);
    expect(task.request).toHaveBeenNthCalledWith(1, "gateway/attachments/retain", {
      paths: [attachment.path],
      threadId: context.snapshot.threadId,
    });
    expect(task.request).toHaveBeenNthCalledWith(2, "gateway/attachments/retain", {
      paths: [attachment.path],
      threadId: context.snapshot.threadId,
    });
    expect(task.request.mock.calls.map(([method]) => method)).toEqual([
      "gateway/attachments/retain",
      "gateway/attachments/retain",
    ]);
    expect(task.request.mock.calls.filter(([method]) => method === "attachment/delete")).toEqual([]);
    expect(releaseLocalAttachmentPreview).not.toHaveBeenCalled();

    resolveRetry();
    await retryPending;
    expect(renderSendingHook(context).failedSubmissions).toHaveLength(0);
  });

  it("hydrates a persisted failed item without auto-sending and retries with its original id", async () => {
    const persisted = {
      id: "composer-1727690400000-stable123",
      content: "recover after reload",
      attachments: [
        {
          filename: "notes.txt",
          mimeType: "text/plain",
          fileSize: 12,
          path: "/mobile/notes.txt",
        },
      ],
      createdAt: 1727690400000,
      outcome: "failed" as const,
      error: "-32025 thread mismatch",
    };
    const task = {
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
    };
    const onFailedSubmissionsChange = vi.fn();
    const context = {
      task,
      demo: false,
      initialFailedSubmissions: [persisted],
      onFailedSubmissionsChange,
      snapshot: {
        threadId: "thread-reloaded",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: { persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(), remove: vi.fn() },
      queuedMessages: [],
      input: "draft B still here",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [],
      setAttachments: vi.fn(),
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    const rehydrated = renderSendingHook(context);
    expect(rehydrated.failedSubmissions).toEqual([
      expect.objectContaining({
        id: persisted.id,
        content: persisted.content,
        outcome: "failed",
        retrying: false,
        attachments: persisted.attachments,
      }),
    ]);
    expect(task.send).not.toHaveBeenCalled();

    await rehydrated.retryFailedSubmission(persisted.id);

    expect(task.send).toHaveBeenCalledWith(
      persisted.content,
      persisted.attachments,
      undefined,
      { clientMessageId: persisted.id },
    );
    expect(renderSendingHook(context).input).toBe("draft B still here");
    expect(renderSendingHook(context).failedSubmissions).toHaveLength(0);
    expect(onFailedSubmissionsChange).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps a failed item across same-runtime panel remount and drops only its preview blob", async () => {
    const attachment = {
      filename: "remount.txt",
      mimeType: "text/plain",
      fileSize: 8,
      path: "/mobile/remount.txt",
      localPreviewUri: "blob:remount",
      ownsLocalPreviewUri: true,
    };
    const task = {
      send: vi.fn(async () => {
        throw new Error("remote turn/start rejection");
      }),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
      request: vi.fn(async () => ({})),
    };
    const context = {
      task,
      demo: false,
      snapshot: {
        threadId: "thread-remount",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: { persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(), remove: vi.fn() },
      queuedMessages: [],
      input: "keep across remount",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [attachment],
      setAttachments: vi.fn(),
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    await renderSendingHook(context).submit();
    const original = renderSendingHook(context).failedSubmissions[0];
    const cleanup = capturedEffects.effects[0]?.();
    expect(cleanup).toBeTypeOf("function");
    if (typeof cleanup === "function") cleanup();

    const remounted = renderSendingHook({
      ...context,
      input: "draft B remains",
      initialFailedSubmissions: [],
    });
    expect(remounted.failedSubmissions).toEqual([
      expect.objectContaining({
        id: original.id,
        content: "keep across remount",
        outcome: "failed",
        attachments: [expect.objectContaining({ path: attachment.path })],
      }),
    ]);
    expect(remounted.failedSubmissions[0]?.attachments[0]).not.toHaveProperty(
      "localPreviewUri",
    );
    expect(remounted.input).toBe("draft B remains");
  });

  it("rechecks a hydrated unknown id by receipt and never replays it", async () => {
    const persisted = {
      id: "composer-1727690400000-unknown123",
      content: "possibly accepted before reload",
      attachments: [],
      createdAt: 1727690400000,
      outcome: "unknown" as const,
    };
    const client = {
      supportsExperimental: vi.fn(() => true),
      request: vi.fn(
        async (method: string, params: Record<string, unknown>) => {
          expect(method).toBe("turn/receipt/read");
          expect(params).toEqual({
            threadId: "thread-reloaded",
            clientMessageId: persisted.id,
          });
          return {
            receipt: {
              threadId: "thread-reloaded",
              turnId: "turn-already-accepted",
              status: "completed",
            },
          };
        },
      ),
    };
    const task = {
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
      acceptanceClient: vi.fn(async () => client),
      uncertainSend: null,
      reconcileSendAcceptance: vi.fn(async () => {}),
    };
    const context = {
      task,
      demo: false,
      initialFailedSubmissions: [persisted],
      snapshot: {
        threadId: "thread-reloaded",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: { persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(), remove: vi.fn() },
      queuedMessages: [],
      input: "draft B still here",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [],
      setAttachments: vi.fn(),
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    const rehydrated = renderSendingHook(context);
    expect(rehydrated.failedSubmissions[0]?.outcome).toBe("unknown");
    expect(task.send).not.toHaveBeenCalled();

    await rehydrated.checkFailedSubmission(persisted.id);

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(task.send).not.toHaveBeenCalled();
    expect(renderSendingHook(context).failedSubmissions).toHaveLength(0);
    expect(renderSendingHook(context).input).toBe("draft B still here");
  });

  it("keeps an unknown item when the receipt is absent and does not send", async () => {
    const persisted = {
      id: "composer-1727690400000-stillunknown",
      content: "do not replay without evidence",
      attachments: [],
      createdAt: 1727690400000,
      outcome: "unknown" as const,
    };
    const client = {
      supportsExperimental: vi.fn(() => true),
      request: vi.fn(async () => ({ receipt: null })),
    };
    const task = {
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
      acceptanceClient: vi.fn(async () => client),
      uncertainSend: null,
      reconcileSendAcceptance: vi.fn(async () => {}),
    };
    const context = {
      task,
      demo: false,
      initialFailedSubmissions: [persisted],
      snapshot: {
        threadId: "thread-reloaded",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: { persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(), remove: vi.fn() },
      queuedMessages: [],
      input: "draft B still here",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [],
      setAttachments: vi.fn(),
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    const model = renderSendingHook(context);
    await model.checkFailedSubmission(persisted.id);

    const stillUnknown = renderSendingHook(context).failedSubmissions[0];
    expect(stillUnknown).toMatchObject({
      id: persisted.id,
      outcome: "unknown",
      retrying: false,
    });
    expect(task.send).not.toHaveBeenCalled();
  });

  it("keeps hydrated unknown acceptance when receipt support is unavailable", async () => {
    const persisted = {
      id: "composer-1727690400000-no-capability",
      content: "do not guess acceptance",
      attachments: [],
      createdAt: 1727690400000,
      outcome: "unknown" as const,
    };
    const client = {
      supportsExperimental: vi.fn(() => false),
      request: vi.fn(),
    };
    const task = {
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
      acceptanceClient: vi.fn(async () => client),
      uncertainSend: null,
      reconcileSendAcceptance: vi.fn(async () => {}),
    };
    const context = {
      task,
      demo: false,
      initialFailedSubmissions: [persisted],
      snapshot: {
        threadId: "thread-reloaded",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: { persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(), remove: vi.fn() },
      queuedMessages: [],
      input: "draft B stays editable",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [],
      setAttachments: vi.fn(),
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    const model = renderSendingHook(context);
    await model.checkFailedSubmission(persisted.id);

    expect(client.request).not.toHaveBeenCalled();
    expect(task.send).not.toHaveBeenCalled();
    expect(renderSendingHook(context).failedSubmissions[0]).toMatchObject({
      id: persisted.id,
      outcome: "unknown",
      retrying: false,
    });
    expect(renderSendingHook(context).input).toBe("draft B stays editable");
  });

  it("pauses persisted queue drain while a restored submission is unknown", () => {
    const queued = {
      id: "queued-message-after-unknown",
      content: "send after reconciling the first message",
      attachments: [],
      createdAt: 123,
    };
    const task = {
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
    };
    const messageQueue = {
      persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(() => queued),
      remove: vi.fn(),
    };
    const context = {
      task,
      demo: false,
      initialFailedSubmissions: [
        {
          id: "composer-1727690400000-unknown-before-queue",
          content: "acceptance unknown",
          attachments: [],
          createdAt: 1727690400000,
          outcome: "unknown" as const,
        },
      ],
      snapshot: {
        threadId: "thread-queue-gate",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue,
      onQueueCommit: vi.fn(async () => {}),
      queuedMessages: [queued],
      input: "",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [],
      setAttachments: vi.fn(),
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    renderSendingHook(context);
    capturedEffects.effects.at(-1)?.();

    expect(task.send).not.toHaveBeenCalled();
    expect(messageQueue.remove).not.toHaveBeenCalled();
  });

  it("keeps the composer draft intact when the recoverable-item limit is full", async () => {
    const initialFailedSubmissions = Array.from(
      { length: MAX_QUEUED_TASK_MESSAGES },
      (_, index) => ({
        id: `composer-1727690400000-${index}`,
        content: `failed item ${index}`,
        attachments: [],
        createdAt: 1727690400000 + index,
        outcome: "failed" as const,
      }),
    );
    const task = {
      send: vi.fn(async () => {}),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
    };
    const setInput = vi.fn();
    const setAttachments = vi.fn();
    const setQueueError = vi.fn();
    const context = {
      task,
      demo: false,
      initialFailedSubmissions,
      snapshot: {
        threadId: "thread-full",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: { persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(), remove: vi.fn() },
      queuedMessages: [],
      input: "new draft must stay",
      setInput,
      goalEditExpectationRef: { current: null },
      attachments: [],
      setAttachments,
      setQueueError,
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    await renderSendingHook(context).submit();

    expect(task.send).not.toHaveBeenCalled();
    expect(setInput).not.toHaveBeenCalled();
    expect(setAttachments).not.toHaveBeenCalled();
    expect(setQueueError).toHaveBeenCalledWith(
      expect.stringContaining(String(MAX_QUEUED_TASK_MESSAGES)),
    );
  });

  it("persists A and its stable id before starting turn/start", async () => {
    let finishFirstPersist!: () => void;
    const events: string[] = [];
    let persisted: readonly unknown[] | undefined;
    let stateAtSend: readonly unknown[] | undefined;
    const task = {
      send: vi.fn(async () => {
        events.push("send");
        stateAtSend = persisted;
      }),
      getSnapshot: vi.fn(() => ({ sendAcceptanceUnknown: false })),
      isDisposed: vi.fn(() => false),
    };
    const onFailedSubmissionsChange = vi.fn(
      (value: readonly unknown[] | undefined) => {
        events.push("persist");
        persisted = value;
        if (onFailedSubmissionsChange.mock.calls.length === 1) {
          return new Promise<void>((resolve) => {
            finishFirstPersist = resolve;
          });
        }
      },
    );
    const context = {
      task,
      demo: false,
      onDraftChange: vi.fn(async () => {}),
      onFailedSubmissionsChange,
      snapshot: {
        threadId: "thread-durable-pending",
        connected: true,
        running: false,
        interaction: null,
        archivedAt: null,
        sendAcceptanceUnknown: false,
      },
      messageQueue: { persistProjection: async (operation: () => Promise<void>) => operation(), first: vi.fn(), remove: vi.fn() },
      queuedMessages: [],
      input: "recover this after reload",
      setInput: vi.fn(),
      goalEditExpectationRef: { current: null },
      attachments: [],
      setAttachments: vi.fn(),
      setQueueError: vi.fn(),
      sendingQueued: { current: false },
      executeSlashCommand: vi.fn(async () => false),
    } as unknown as Parameters<typeof useTaskSending>[0];

    const submission = renderSendingHook(context).submit();
    await vi.waitFor(() =>
      expect(onFailedSubmissionsChange).toHaveBeenCalledTimes(1),
    );
    expect(task.send).not.toHaveBeenCalled();
    expect(persisted).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^composer-/),
        content: "recover this after reload",
        outcome: "failed",
      }),
    ]);

    finishFirstPersist();
    await vi.waitFor(() => expect(task.send).toHaveBeenCalledTimes(1));
    await submission;

    expect(events).toEqual(["persist", "persist", "send", "persist"]);
    expect(stateAtSend).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^composer-/),
        content: "recover this after reload",
        outcome: "unknown",
      }),
    ]);
    expect(persisted).toBeUndefined();
  });
});
