import { beforeEach, expect, test, vi } from "vitest";
import { MobileRpcError } from "@/gateway/rpc";
import { TaskMessageQueue } from "@/runtime/task-message-queue";
import type { WorkspaceFailedSubmission } from "@/storage/workspace-preferences";
import { RETAIN_TASK_ATTACHMENTS } from "../../../../shared/attachmentRetention";
import { useTaskSending } from "./useTaskSending";

// Direct production-hook calls through a deterministic hook host; this is not
// a mounted React or rendered-screen test. It preserves hook slots and stable
// state setters while observing real queue/store snapshots.
const hookHost = vi.hoisted(() => ({
  slots: [] as { kind: "ref" | "state"; value: any; setter?: (next: any) => void }[],
  cursor: 0,
  effects: [] as (() => unknown)[],
}));

vi.mock("react", () => ({
  useEffect: (effect: () => unknown) => hookHost.effects.push(effect),
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

vi.mock("./attachmentPreparation", () => ({
  releaseLocalAttachmentPreview: vi.fn(),
  wireAttachment: (attachment: unknown) => attachment,
}));

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

function trackedRef<T>(initial: T) {
  const transitions = observed<T>();
  let value = initial;
  const ref = Object.defineProperty({}, "current", {
    get: () => value,
    set: (next: T) => {
      value = next;
      transitions.push(next);
    },
  }) as { current: T };
  return { ref, transitions };
}

const RETRY_ID = "failed-message-stable-id";
const RETRY_ATTACHMENT = {
  path: "/private/attachments/failed.png",
  filename: "failed.png",
  mimeType: "image/png",
  fileSize: 1,
};

function failedRecord() {
  return [{
    id: RETRY_ID,
    content: "the original message body",
    attachments: [{ ...RETRY_ATTACHMENT }],
    createdAt: 123,
    outcome: "failed" as const,
  }];
}

function makeOwner(options: {
  id: string;
  task?: any;
  initialFailed?: ReturnType<typeof failedRecord>;
  queued?: { id: string; content: string; attachments: typeof RETRY_ATTACHMENT[]; createdAt: number }[];
  input?: string;
  authorizationGeneration?: string;
}) {
  const state: {
    input: string;
    attachments: typeof RETRY_ATTACHMENT[];
    persistedDraft: string | undefined;
    persistedFailed: WorkspaceFailedSubmission[] | undefined;
  } = {
    input: options.input ?? "",
    attachments: [] as typeof RETRY_ATTACHMENT[],
    persistedDraft: options.input,
    persistedFailed: options.initialFailed,
  };
  const retainCalls = observed<{ method: string; params: unknown }>();
  const retainReceipts: Deferred<void>[] = [];
  const sendCalls = observed<unknown[]>();
  const sendReceipts: Deferred<void>[] = [];
  const queueErrors = observed<unknown>();
  const queueErrorsNonNull = observed<unknown>();
  const running = trackedRef(false);
  const messageQueue = new TaskMessageQueue();
  if (options.queued) messageQueue.replace(options.queued);

  const snapshot: any = {
    threadId: "same-thread-id",
    connected: true,
    configurationReady: true,
    sendAcceptanceUnknown: false,
    running: false,
    interaction: null,
    archivedAt: undefined,
  };
  const owner: any = {
    id: options.id,
    state,
    snapshot,
    messageQueue,
    retainCalls,
    retainReceipts,
    sendCalls,
    sendReceipts,
    queueErrors,
    queueErrorsNonNull,
    runningTransitions: running.transitions,
    sendingQueued: running.ref,
    initialFailedSubmissions: options.initialFailed ?? [],
    profile: {
      id: "profile",
      baseUrl: "https://gateway.example",
      authorizationGeneration: options.authorizationGeneration ?? "authorization-1",
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
      accountIdentity: { principalId: "principal", role: "member" },
    },
    mountedRef: { current: true },
    pendingAttachmentSubmissions: { current: new Map<string, number>() },
    removedPendingAttachments: { current: new Set<string>() },
    inputIntentRef: { current: { value: state.input, revision: 0 } },
    goalEditExpectationRef: { current: null },
    task: null as any,
    resolveRetain(index: number) {
      retainReceipts[index].resolve(undefined);
    },
    rejectRetain(index: number, error: unknown) {
      retainReceipts[index].reject(error);
    },
    resolveSend(index: number) {
      sendReceipts[index].resolve(undefined);
    },
    rejectSend(index: number, error: unknown) {
      sendReceipts[index].reject(error);
    },
  };
  owner.task = options.task ?? {
    request: vi.fn((method: string, params: unknown) => {
      const request = { method, params };
      if (method === RETAIN_TASK_ATTACHMENTS) {
        retainCalls.push(request);
        const receipt = deferred<void>();
        retainReceipts.push(receipt);
        return receipt.promise;
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
    getSnapshot: vi.fn(() => snapshot),
  };
  owner.onDraftChange = vi.fn(async (value: string | undefined) => {
    state.persistedDraft = value;
  });
  owner.onFailedSubmissionsChange = vi.fn(async (value: WorkspaceFailedSubmission[] | undefined) => {
    state.persistedFailed = value;
  });
  owner.setInput = (next: string | ((current: string) => string)) => {
    const value = typeof next === "function" ? next(state.input) : next;
    state.input = value;
    owner.inputIntentRef.current = {
      value,
      revision: owner.inputIntentRef.current.revision + 1,
    };
  };
  owner.setAttachments = (next: typeof state.attachments | ((current: typeof state.attachments) => typeof state.attachments)) => {
    state.attachments = typeof next === "function" ? next(state.attachments) : next;
  };
  owner.setQueueError = vi.fn((value: unknown) => {
    queueErrors.push(value);
    if (value !== null) queueErrorsNonNull.push(value);
  });
  return owner;
}

function makeHookHost() {
  const context: any = {};
  return {
    render(owner: ReturnType<typeof makeOwner>) {
      Object.assign(context, {
        task: owner.task,
        profile: owner.profile,
        server: owner.server,
        demo: false,
        onDraftChange: owner.onDraftChange,
        snapshot: owner.snapshot,
        messageQueue: owner.messageQueue,
        queuedMessages: owner.messageQueue.getSnapshot(),
        initialFailedSubmissions: owner.initialFailedSubmissions,
        onFailedSubmissionsChange: owner.onFailedSubmissionsChange,
        onQueueCommit: vi.fn(async () => {}),
        input: owner.state.input,
        setInput: owner.setInput,
        inputIntentRef: owner.inputIntentRef,
        goalEditExpectationRef: owner.goalEditExpectationRef,
        attachments: owner.state.attachments,
        setAttachments: owner.setAttachments,
        mountedRef: owner.mountedRef,
        pendingAttachmentSubmissions: owner.pendingAttachmentSubmissions,
        removedPendingAttachments: owner.removedPendingAttachments,
        setQueueError: owner.setQueueError,
        sendingQueued: owner.sendingQueued,
        executeSlashCommand: async () => false,
      });
      hookHost.cursor = 0;
      hookHost.effects = [];
      const actions = useTaskSending(context as never);
      return { actions, effects: [...hookHost.effects] };
    },
  };
}

beforeEach(() => {
  hookHost.slots = [];
  hookHost.cursor = 0;
  hookHost.effects = [];
  vi.clearAllMocks();
});

test("a failed-send retry retains attachments before one send with the original message ID", async () => {
  const owner = makeOwner({ id: "retry-success", initialFailed: failedRecord() });
  const rendered = makeHookHost().render(owner);
  const retry = rendered.actions.retryFailedSubmission(RETRY_ID);

  await owner.retainCalls.waitFor(1);
  expect(owner.retainCalls.values[0]).toEqual({
    method: RETAIN_TASK_ATTACHMENTS,
    params: {
      threadId: "same-thread-id",
      paths: [RETRY_ATTACHMENT.path],
    },
  });
  owner.resolveRetain(0);

  await owner.sendCalls.waitFor(1);
  expect(owner.sendCalls.values).toHaveLength(1);
  expect(owner.sendCalls.values[0]).toEqual([
    "the original message body",
    [{ ...RETRY_ATTACHMENT }],
    undefined,
    { clientMessageId: RETRY_ID },
  ]);
  owner.resolveSend(0);
  await retry;

  expect(owner.retainCalls.values).toHaveLength(1);
  expect(owner.sendCalls.values).toHaveLength(1);
  expect(owner.state.persistedFailed).toBeUndefined();
});

test.each([
  ["explicit refusal", new MobileRpcError("attachment rejected", -32048, "remote", "not-sent")],
  ["lost retain response", new MobileRpcError("retain response lost", -1, "transport", "unknown")],
])("a %s during retry preserves the recovery record and never sends", async (_label, error) => {
  const owner = makeOwner({ id: "retry-refused", initialFailed: failedRecord() });
  const host = makeHookHost();
  const rendered = host.render(owner);
  const retry = rendered.actions.retryFailedSubmission(RETRY_ID);
  await owner.retainCalls.waitFor(1);
  owner.rejectRetain(0, error);
  await retry;

  expect(owner.sendCalls.values).toHaveLength(0);
  expect(owner.retainCalls.values).toHaveLength(1);
  expect(owner.state.persistedFailed).toEqual([
    expect.objectContaining({
      id: RETRY_ID,
      content: "the original message body",
      outcome: "failed",
      attachments: [expect.objectContaining({ path: RETRY_ATTACHMENT.path })],
    }),
  ]);
  expect(host.render(owner).actions.failedSubmissions).toEqual([
    expect.objectContaining({
      id: RETRY_ID,
      content: "the original message body",
      outcome: "failed",
      phase: "retaining",
      retrying: false,
      attachments: [expect.objectContaining({ path: RETRY_ATTACHMENT.path })],
    }),
  ]);
});

test("an auth-generation change while retry retain is held prevents dispatch into the new owner", async () => {
  const ownerA = makeOwner({ id: "scope-a", initialFailed: failedRecord() });
  const host = makeHookHost();
  const actionsA = host.render(ownerA).actions;
  const retry = actionsA.retryFailedSubmission(RETRY_ID);
  await ownerA.retainCalls.waitFor(1);

  // Keep the runtime and thread IDs stable so authorization generation is the
  // scope boundary that invalidates this in-flight retry.
  const ownerB = makeOwner({
    id: "scope-b",
    task: ownerA.task,
    authorizationGeneration: "authorization-2",
    input: "B draft",
  });
  const actionsB = host.render(ownerB).actions;
  ownerA.resolveRetain(0);
  await retry;

  expect(ownerA.task.send).not.toHaveBeenCalled();
  expect(ownerB.onFailedSubmissionsChange).not.toHaveBeenCalled();
  expect(ownerB.state.input).toBe("B draft");
  expect(ownerB.state.persistedDraft).toBe("B draft");
  expect(actionsB.failedSubmissions).toHaveLength(1); // the shared runtime's original recovery item
});

test("a restored queue row remains after retain returns unknown and is not sent", async () => {
  const row = {
    id: "queued-restored-id",
    content: "restored queued body",
    attachments: [{ ...RETRY_ATTACHMENT }],
    createdAt: 456,
  };
  const owner = makeOwner({ id: "queue-unknown", queued: [row] });
  const rendered = makeHookHost().render(owner);
  rendered.effects.at(-1)?.();
  await owner.retainCalls.waitFor(1);
  owner.rejectRetain(0, new MobileRpcError("retain outcome unknown", -1, "transport", "unknown"));
  await owner.queueErrorsNonNull.waitFor(1);
  await owner.runningTransitions.waitFor(2);

  expect(owner.sendCalls.values).toHaveLength(0);
  expect(owner.messageQueue.getSnapshot()).toEqual([row]);
  expect(owner.queueErrorsNonNull.values).toHaveLength(1);
});

test("removing a queued row while retain is held prevents its later dispatch", async () => {
  const row = {
    id: "queued-remove-during-retain",
    content: "body removed while preparing",
    attachments: [{ ...RETRY_ATTACHMENT }],
    createdAt: 789,
  };
  const owner = makeOwner({ id: "queue-remove", queued: [row] });
  const rendered = makeHookHost().render(owner);
  rendered.effects.at(-1)?.();
  await owner.retainCalls.waitFor(1);

  rendered.actions.removeQueuedMessage(row.id);
  expect(owner.messageQueue.getSnapshot()).toHaveLength(0);
  owner.resolveRetain(0);
  await owner.runningTransitions.waitFor(2);

  expect(owner.sendCalls.values).toHaveLength(0);
  expect(owner.messageQueue.getSnapshot()).toHaveLength(0);
  expect(owner.retainCalls.values).toHaveLength(1);
});

test("an unknown turn-start acceptance cannot trigger a second retain or send", async () => {
  const owner = makeOwner({ id: "acceptance-unknown", initialFailed: failedRecord() });
  const host = makeHookHost();
  const rendered = host.render(owner);
  const retry = rendered.actions.retryFailedSubmission(RETRY_ID);
  await owner.retainCalls.waitFor(1);
  owner.resolveRetain(0);
  await owner.sendCalls.waitFor(1);

  owner.snapshot.sendAcceptanceUnknown = true;
  owner.snapshot.error = "turn acceptance is unknown";
  owner.rejectSend(0, new MobileRpcError("turn response lost", -1, "transport", "unknown"));
  await retry;

  const afterUnknown = host.render(owner);
  expect(afterUnknown.actions.failedSubmissions).toEqual([
    expect.objectContaining({
      id: RETRY_ID,
      content: "the original message body",
      outcome: "unknown",
      retrying: false,
      attachments: [expect.objectContaining({ path: RETRY_ATTACHMENT.path })],
    }),
  ]);
  await afterUnknown.actions.retryFailedSubmission(RETRY_ID);

  expect(owner.retainCalls.values).toHaveLength(1);
  expect(owner.sendCalls.values).toHaveLength(1);
});
