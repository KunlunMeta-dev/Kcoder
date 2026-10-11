import { beforeEach, expect, test, vi } from "vitest";
import { RETAIN_TASK_ATTACHMENTS } from "../../../../shared/attachmentRetention";
import { TaskMessageQueue } from "@/runtime/task-message-queue";
import { useTaskCommands } from "./useTaskCommands";

// This is a deterministic hook host, not a mounted React/component test. The
// production hooks below run directly; the host preserves React's hook slots,
// stable state setters, and the failed-submission store's real snapshots.
const hookHost = vi.hoisted(() => ({
  slots: [] as {
    kind: "ref" | "state" | "memo";
    value: any;
    setter?: (next: any) => void;
    deps?: readonly unknown[];
  }[],
  cursor: 0,
}));

vi.mock("react", () => ({
  useEffect: vi.fn(),
  useMemo: (factory: () => unknown, deps: readonly unknown[]) => {
    const index = hookHost.cursor++;
    const slot = hookHost.slots[index];
    if (
      slot?.kind === "memo" &&
      slot.deps?.length === deps.length &&
      deps.every((dependency, depIndex) => Object.is(dependency, slot.deps?.[depIndex]))
    ) {
      return slot.value;
    }
    const value = factory();
    hookHost.slots[index] = { kind: "memo", value, deps: [...deps] };
    return value;
  },
  useRef: (initial: unknown) => {
    const index = hookHost.cursor++;
    let slot = hookHost.slots[index];
    if (!slot) {
      slot = { kind: "ref", value: { current: initial } };
      hookHost.slots[index] = slot;
    }
    return slot.value;
  },
  useState: (initial: unknown) => {
    const index = hookHost.cursor++;
    let slot = hookHost.slots[index];
    if (!slot) {
      slot = {
        kind: "state",
        value: typeof initial === "function" ? (initial as () => unknown)() : initial,
      };
      hookHost.slots[index] = slot;
    }
    if (!slot.setter) {
      slot.setter = (next) => {
        slot!.value = typeof next === "function" ? next(slot!.value) : next;
      };
    }
    return [slot.value, slot.setter];
  },
  useSyncExternalStore: (
    _subscribe: (listener: () => void) => () => void,
    getSnapshot: () => unknown,
  ) => getSnapshot(),
}));

vi.mock("@/platform/confirmation", () => ({ requestConfirmation: vi.fn() }));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("expo-file-system/legacy", () => ({}));
vi.mock("expo-image-manipulator", () => ({}));
vi.mock("expo-image-picker", () => ({}));
vi.mock("./attachmentPreparation", () => ({
  releaseLocalAttachmentPreview: vi.fn(),
  wireAttachment: (attachment: unknown) => attachment,
}));

import { releaseLocalAttachmentPreview } from "./attachmentPreparation";
import { useTaskAttachments } from "./useTaskAttachments";
import { useTaskSending } from "./useTaskSending";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value),
    reject: rejectPromise,
  };
}

function observed<T>() {
  const values: T[] = [];
  const waiters: { count: number; resolve(): void }[] = [];
  return {
    values,
    push(value: T) {
      values.push(value);
      for (let index = waiters.length - 1; index >= 0; index--) {
        if (values.length >= waiters[index].count) {
          waiters.splice(index, 1)[0].resolve();
        }
      }
    },
    waitFor(count: number): Promise<void> {
      if (values.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
  };
}

beforeEach(() => {
  hookHost.slots = [];
  hookHost.cursor = 0;
  vi.clearAllMocks();
});

function commandFixture(initial: string) {
  const state = { input: initial, persistedDraft: initial as string | undefined };
  const inputIntentRef = { current: { value: initial, revision: 0 } };
  const setInput = (next: string | ((current: string) => string)) => {
    const value =
      typeof next === "function" ? next(inputIntentRef.current.value) : next;
    if (value === inputIntentRef.current.value) return;
    inputIntentRef.current = {
      value,
      revision: inputIntentRef.current.revision + 1,
    };
    state.input = value;
  };
  const receipt = deferred<unknown>();
  const task = {
    compact: vi.fn(() => receipt.promise),
    rename: vi.fn(() => receipt.promise),
    request: vi.fn(() => receipt.promise),
  };
  const context = {
    input: initial,
    inputIntentRef,
    task,
    snapshot: { threadId: "thread", running: false, interaction: null },
    attachments: [],
    goalEditExpectationRef: { current: null },
    messageQueue: new TaskMessageQueue(),
    messageInputRef: { current: { focus: vi.fn() } },
    setInput,
    onDraftChange: vi.fn(async (value: string | undefined) => {
      state.persistedDraft = value;
    }),
    openModelPicker: vi.fn(),
    setQueueError: vi.fn(),
    setComposerNotice: vi.fn(),
  };
  return {
    state,
    context,
    receipt,
    edit(value: string) {
      setInput(value);
      context.input = value;
      return context.onDraftChange(value);
    },
  };
}

test.each(["/compact", "/rename updated", "/moa"])(
  "a delayed %s receipt preserves the next draft",
  async (command) => {
    const host = commandFixture(command);
    const commands = useTaskCommands(host.context as never);
    const executing = commands.executeSlashCommand(command);

    await host.edit("next draft");
    host.receipt.resolve({
      compacted: true,
      preTokens: 10,
      postTokens: 5,
      moaSummary: "modes",
    });
    await executing;

    expect(host.state.input).toBe("next draft");
    expect(host.state.persistedDraft).toBe("next draft");
    expect(host.context.onDraftChange).not.toHaveBeenCalledWith(undefined);
  },
);

function sendingFixture(
  running: boolean,
  options: { holdRetain?: boolean } = {},
) {
  hookHost.slots = [];
  const retainCalls = observed<{ method: string; params: unknown }>();
  const retainReceipts: Deferred<void>[] = [];
  const sendCalls = observed<unknown[]>();
  const sendReceipts: Deferred<void>[] = [];
  const requestCalls: { method: string; params: unknown }[] = [];
  const state: {
    input: string;
    attachments: { path: string; filename: string }[];
    persistedDraft: string | undefined;
    persistedQueue: unknown;
    persistedFailed: any[] | undefined;
  } = {
    input: "first message",
    attachments: [{ path: "first.png", filename: "first.png" }],
    persistedDraft: "first message",
    persistedQueue: undefined,
    persistedFailed: undefined,
  };
  const inputIntentRef = { current: { value: state.input, revision: 0 } };
  const latestInputRef = { current: state.input };
  const inputRevisionRef = { current: 0 };
  const setInput = (next: string | ((current: string) => string)) => {
    const value =
      typeof next === "function" ? next(inputIntentRef.current.value) : next;
    if (value === inputIntentRef.current.value) return;
    const revision = inputIntentRef.current.revision + 1;
    inputIntentRef.current = { value, revision };
    latestInputRef.current = value;
    inputRevisionRef.current = revision;
    state.input = value;
  };
  const messageQueue = new TaskMessageQueue();
  const context: any = {
    task: null,
    profile: {
      id: "profile",
      baseUrl: "https://gateway.example",
      authorizationGeneration: "auth-generation-1",
      deviceId: "device-1",
    },
    server: {
      id: "server",
      profile: "account",
      host: "host",
      user: "user",
      port: 22,
      command: "kcoder",
      workspacePath: "/workspace",
      transport: "ssh",
      settingsFile: "settings.json",
      accountIdentity: { principalId: "principal-1", role: "member" },
    },
    demo: false,
    onDraftChange: vi.fn(async (value: string | undefined) => {
      state.persistedDraft = value;
    }),
    onQueuedMessagesChange: vi.fn(async (value: unknown) => {
      state.persistedQueue = value;
    }),
    onFailedSubmissionsChange: vi.fn(async (value: any[] | undefined) => {
      state.persistedFailed = value;
    }),
    onQueueCommit: vi.fn(async (value: { queuedMessages: unknown; failedSubmissions: any[] | undefined }) => {
      state.persistedQueue = value.queuedMessages;
      state.persistedFailed = value.failedSubmissions;
    }),
    initialFailedSubmissions: [],
    snapshot: {
      threadId: "thread",
      connected: true,
      configurationReady: true,
      sendAcceptanceUnknown: false,
      running,
      interaction: null,
      archivedAt: undefined,
    },
    messageQueue,
    queuedMessages: [],
    input: state.input,
    inputIntentRef,
    latestInputRef,
    inputRevisionRef,
    setInput,
    goalEditExpectationRef: { current: null },
    attachments: state.attachments,
    setAttachments: (
      next:
        | typeof state.attachments
        | ((current: typeof state.attachments) => typeof state.attachments),
    ) => {
      state.attachments =
        typeof next === "function" ? next(state.attachments) : next;
    },
    pendingAttachmentSubmissions: { current: new Map<string, number>() },
    removedPendingAttachments: { current: new Set<string>() },
    mountedRef: { current: true },
    setQueueError: vi.fn(),
    setComposerNotice: vi.fn(),
    sendingQueued: { current: false },
    executeSlashCommand: async () => false,
  };
  context.task = {
    request: vi.fn((method: string, params: unknown) => {
      requestCalls.push({ method, params });
      if (method === RETAIN_TASK_ATTACHMENTS) {
        retainCalls.push({ method, params });
        if (options.holdRetain) {
          const receipt = deferred<void>();
          retainReceipts.push(receipt);
          return receipt.promise;
        }
        return Promise.resolve();
      }
      return Promise.resolve();
    }),
    send: vi.fn((...args: unknown[]) => {
      sendCalls.push(args);
      const receipt = deferred<void>();
      sendReceipts.push(receipt);
      return receipt.promise;
    }),
    isDisposed: vi.fn(() => false),
    getSnapshot: vi.fn(() => context.snapshot),
  };
  const queues = [messageQueue];
  const render = () => {
    hookHost.cursor = 0;
    context.input = state.input;
    context.attachments = state.attachments;
    context.queuedMessages = context.messageQueue.getSnapshot();
    return useTaskSending(context as never);
  };
  const edit = async (value: string) => {
    setInput(value);
    await context.onDraftChange(value || undefined);
  };
  const addAttachment = (path: string) => {
    context.setAttachments((current: typeof state.attachments) => [
      ...current,
      { path, filename: path },
    ]);
  };
  return {
    state,
    context,
    retainCalls: retainCalls.values,
    retainReceipts,
    sendCalls: sendCalls.values,
    sendReceipts,
    requestCalls,
    queues,
    render,
    edit,
    addAttachment,
    waitForRetainCount: retainCalls.waitFor,
    waitForSendCount: sendCalls.waitFor,
    resolveRetain(index: number) {
      retainReceipts[index].resolve(undefined);
    },
    rejectRetain(index: number, error: Error) {
      retainReceipts[index].reject(error);
    },
    resolveSend(index: number) {
      sendReceipts[index].resolve(undefined);
    },
    rejectSend(index: number, error: Error) {
      sendReceipts[index].reject(error);
    },
    switchTask() {
      const nextQueue = new TaskMessageQueue();
      queues.push(nextQueue);
      context.messageQueue = nextQueue;
      context.task = { ...context.task, getSnapshot: () => context.snapshot };
      return nextQueue;
    },
  };
}

test.each([false, true])(
  "delayed send receipt preserves new input, attachments and persisted draft; queued=%s",
  async (running) => {
    const host = sendingFixture(running, { holdRetain: running });
    const submission = host.render().submit();
    if (running) await host.waitForRetainCount(1);
    else await host.waitForSendCount(1);

    await host.edit("next draft");
    host.addAttachment("later.png");
    host.render();
    if (running) host.resolveRetain(0);
    else host.resolveSend(0);
    await submission;

    expect(host.state.input).toBe("next draft");
    expect(host.state.attachments.map((item) => item.path)).toEqual([
      "later.png",
    ]);
    expect(host.state.persistedDraft).toBe("next draft");
    expect(
      vi
        .mocked(releaseLocalAttachmentPreview)
        .mock.calls.map((call) => (call[0] as { path: string }).path),
    ).toContain("first.png");
  },
);

test("repeated queue taps submit once while a new draft owns its own attachment", async () => {
  const host = sendingFixture(true, { holdRetain: true });
  const firstModel = host.render();
  const first = firstModel.submit();
  const duplicate = firstModel.submit();
  await host.waitForRetainCount(1);
  expect(host.retainCalls).toHaveLength(1);

  await host.edit("second message");
  host.addAttachment("second.png");
  const second = host.render().submit();
  await host.waitForRetainCount(2);
  host.resolveRetain(1);
  await second;
  host.resolveRetain(0);
  await Promise.all([first, duplicate]);

  expect(
    host.context.messageQueue.getSnapshot().map((item: any) => item.content),
  ).toEqual(["first message", "second message"]);
  expect(
    host.context.messageQueue
      .getSnapshot()
      .map((item: any) => item.attachments.map((attachment: any) => attachment.path)),
  ).toEqual([["first.png"], ["second.png"]]);
  expect(host.retainCalls).toHaveLength(2);
});

test("a failed queued retain stays recoverable and does not keep the composer gate stuck", async () => {
  const host = sendingFixture(true, { holdRetain: true });
  const submission = host.render().submit();
  await host.waitForRetainCount(1);
  host.rejectRetain(0, new Error("retain failed"));
  await submission;

  let result = host.render();
  expect(host.state.input).toBe("");
  expect(result.failedSubmissions).toHaveLength(1);
  const failed = result.failedSubmissions[0];
  expect(failed.content).toBe("first message");
  expect(failed.attachments.map((item: any) => item.path)).toEqual([
    "first.png",
  ]);
  expect(failed.outcome).toBe("failed");
  expect(host.context.messageQueue.getSnapshot()).toHaveLength(0);

  // The original intent remains in the recovery card; a new composer revision
  // is independently admissible after the held submission has settled.
  await host.edit("next message");
  result = host.render();
  expect(result.canSend).toBe(true);
  const next = result.submit();
  await next;
  expect(host.retainCalls).toHaveLength(1);
  expect(host.context.messageQueue.getSnapshot().map((item: any) => item.content)).toEqual([
    "next message",
  ]);
  expect(host.render().failedSubmissions[0].id).toBe(failed.id);
});

test.each([
  "task",
  "profile",
  "server",
  "thread",
  "origin",
  "account",
  "host",
  "unmount",
])("an old retain receipt cannot dispatch into a new %s lifecycle", async (boundary) => {
  const host = sendingFixture(true, { holdRetain: true });
  const originalTask = host.context.task;
  const oldQueue = host.context.messageQueue;
  const submission = host.render().submit();
  await host.waitForRetainCount(1);
  await host.edit("new lifecycle draft");
  host.context.setAttachments([{ path: "later.png", filename: "later.png" }]);

  let newQueue = oldQueue;
  if (boundary === "task") newQueue = host.switchTask();
  else if (boundary === "profile")
    host.context.profile = { ...host.context.profile, id: "other-profile" };
  else if (boundary === "server")
    host.context.server = { ...host.context.server, id: "other-server" };
  else if (boundary === "thread") host.context.snapshot.threadId = "other-thread";
  else if (boundary === "origin")
    host.context.profile.baseUrl = "https://other-gateway.example";
  else if (boundary === "account") host.context.server.profile = "other-account";
  else if (boundary === "host") host.context.server.host = "other-host";
  else host.context.mountedRef.current = false;

  host.render();
  host.resolveRetain(0);
  await submission;

  expect(host.state.input).toBe("new lifecycle draft");
  expect(host.state.attachments.map((item) => item.path)).toEqual(["later.png"]);
  expect(oldQueue.getSnapshot()).toHaveLength(0);
  expect(newQueue.getSnapshot()).toHaveLength(0);
  expect(originalTask.send).not.toHaveBeenCalled();
  const oldRecovery = host.state.persistedFailed?.find(
    (item) => item.content === "first message",
  );
  expect(oldRecovery?.attachments.map((item: any) => item.path)).toEqual([
    "first.png",
  ]);
  expect(originalTask.request).not.toHaveBeenCalledWith("attachment/delete", {
    path: "first.png",
  });
  expect(host.context.pendingAttachmentSubmissions.current.size).toBe(0);
});

test("a failed ordinary send keeps its attachment in recovery without replacing newer composer state", async () => {
  const host = sendingFixture(false);
  const submission = host.render().submit();
  await host.waitForSendCount(1);
  await host.edit("new draft");
  host.addAttachment("later.png");
  host.render();
  host.rejectSend(0, new Error("send failed"));
  await submission;

  const result = host.render();
  expect(host.state.input).toBe("new draft");
  expect(host.state.attachments.map((item) => item.path)).toEqual([
    "later.png",
  ]);
  expect(host.state.persistedDraft).toBe("new draft");
  expect(result.failedSubmissions).toHaveLength(1);
  expect(result.failedSubmissions[0].content).toBe("first message");
  expect(result.failedSubmissions[0].attachments.map((item: any) => item.path)).toEqual([
    "first.png",
  ]);
});

test.each([false, true])(
  "removing an attachment during retain preserves snapshot ownership; retain succeeds=%s",
  async (success) => {
    const host = sendingFixture(true, { holdRetain: true });
    const submission = host.render().submit();
    await host.waitForRetainCount(1);
    const attachmentActions = useTaskAttachments({
      ...host.context,
      setAttachmentError: vi.fn(),
    } as never);
    await attachmentActions.removeAttachment({
      path: "first.png",
      filename: "first.png",
    } as never);
    expect(host.requestCalls).not.toContainEqual({
      method: "attachment/delete",
      params: { path: "first.png" },
    });
    expect(host.state.attachments).toEqual([]);

    if (success) host.resolveRetain(0);
    else host.rejectRetain(0, new Error("retain failed"));
    await submission;
    expect(host.context.pendingAttachmentSubmissions.current.size).toBe(0);
    if (success) {
      expect(host.requestCalls).not.toContainEqual({
        method: "attachment/delete",
        params: { path: "first.png" },
      });
      expect(host.context.messageQueue.getSnapshot()).toHaveLength(1);
      expect((host.context.messageQueue.getSnapshot()[0] as any).attachments.map((item: any) => item.path)).toEqual([
        "first.png",
      ]);
    } else {
      expect(host.requestCalls).toContainEqual({
        method: "attachment/delete",
        params: { path: "first.png" },
      });
      expect(host.context.messageQueue.getSnapshot()).toHaveLength(0);
      expect(host.render().failedSubmissions[0].attachments).toEqual([]);
    }
  },
);

test("unmount before the async slash preflight finishes releases the submitted attachment", async () => {
  const host = sendingFixture(true, { holdRetain: true });
  const preflight = deferred<boolean>();
  host.context.executeSlashCommand = () => preflight.promise;
  const submission = host.render().submit();
  host.context.mountedRef.current = false;
  preflight.resolve(false);
  await submission;

  expect(host.context.task.request).toHaveBeenCalledWith("attachment/delete", {
    path: "first.png",
  });
  expect(host.context.task.send).not.toHaveBeenCalled();
  expect(host.context.messageQueue.getSnapshot()).toHaveLength(0);
  expect(host.context.pendingAttachmentSubmissions.current.size).toBe(0);
});

test("pending queued submissions own separate attachment snapshots", async () => {
  const host = sendingFixture(true, { holdRetain: true });
  const first = host.render().submit();
  await host.waitForRetainCount(1);
  expect(host.state.input).toBe("");
  expect(host.state.attachments).toEqual([]);

  await host.edit("next message");
  host.addAttachment("second.png");
  const second = host.render().submit();
  await host.waitForRetainCount(2);
  host.resolveRetain(1);
  await second;
  host.resolveRetain(0);
  await first;

  expect(
    host.context.messageQueue
      .getSnapshot()
      .map((item: any) => [item.content, item.attachments.map((attachment: any) => attachment.path)]),
  ).toEqual([
    ["first message", ["first.png"]],
    ["next message", ["second.png"]],
  ]);
});

test.each([false, true])(
  "a failed send never restores over a newer deliberately emptied draft; queued=%s",
  async (running) => {
    const host = sendingFixture(running, { holdRetain: running });
    const submission = host.render().submit();
    if (running) await host.waitForRetainCount(1);
    else await host.waitForSendCount(1);
    await host.edit("new draft");
    await host.edit("");
    host.render();
    if (running) host.rejectRetain(0, new Error("submission failed"));
    else host.rejectSend(0, new Error("submission failed"));
    await submission;

    expect(host.state.input).toBe("");
    expect(host.state.persistedDraft).toBeUndefined();
    expect(host.render().failedSubmissions[0].content).toBe("first message");
  },
);
