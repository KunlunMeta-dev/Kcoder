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
import {
  loadWorkspaceState,
  saveWorkspaceState,
  workspaceStateAuthorizationScope,
  type WorkspaceFailedSubmission,
  type WorkspaceViewState,
} from "@/storage/workspace-preferences";
import {
  FakeClient,
  profile,
  server,
} from "@/runtime/task-runtime/fixture.test-support";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { captureWorkspaceProfileIdentity } from "@/storage/workspace-profile-fence";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => localStorage.getItem(key),
    setItem: async (key: string, value: string) => localStorage.setItem(key, value),
    removeItem: async (key: string) => localStorage.removeItem(key),
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
  onQueueCommit?: (
    value: Pick<WorkspaceViewState, "queuedMessages" | "failedSubmissions">
  ) => void | Promise<void>,
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
    onQueueCommit,
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

  it("persists acceptance before held history and hydrates it into a fresh runtime without granting resend authority", async () => {
    const { runtime, client, starts } = await resumeRuntime();
    const threadId = runtime.getSnapshot().threadId;
    const attachment = { path: "/owned/accepted.txt", filename: "accepted.txt", mimeType: "text/plain", fileSize: 4 };
    const failed: WorkspaceFailedSubmission = { id: "composer-durable-accepted", content: "original", attachments: [attachment], createdAt: 10, outcome: "unknown" };
    const context = contextFor(runtime, "new draft", [], [failed]);
    context.onFailedSubmissionsChange.mockImplementation(async items => {
      await saveWorkspaceState(profile.id, server.id, threadId, { failedSubmissions: items }, workspaceStateAuthorizationScope(profile, server), captureWorkspaceProfileIdentity(profile));
    });
    let release!: (value: unknown) => void;
    client.supportsExperimental = capability => capability === "turnReceiptsV1";
    client.request = vi.fn(async (method: string) => {
      if (method === "turn/receipt/read") return { receipt: { threadId, turnId: "accepted-turn", attemptId: "attempt-1", status: "completed" } };
      if (method === "thread/read") return await new Promise(resolve => { release = resolve; });
      throw new Error(`Unexpected mutation: ${method}`);
    }) as never;
    let reloaded: Awaited<ReturnType<typeof resumeRuntime>> | undefined;
    try {
      const checking = renderComposerSend(context).checkFailedSubmission(failed.id);
      await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("thread/read", expect.anything()));
      const saved = await loadWorkspaceState(profile.id, server.id, threadId, workspaceStateAuthorizationScope(profile, server));
      expect(saved.failedSubmissions?.[0]).toMatchObject({ id: failed.id, attachments: [attachment], outcome: "unknown",
        acceptedTurn: { threadId, turnId: "accepted-turn", attemptId: "attempt-1" } });
      release({ messages: [], hasMoreBefore: true });
      await checking;
      reloaded = await resumeRuntime();
      hookHarness.refs = []; hookHarness.states = [];
      const restored = contextFor(reloaded.runtime, "", [], saved.failedSubmissions);
      reloaded.client.supportsExperimental = capability => capability === "turnReceiptsV1";
      reloaded.client.request = vi.fn(async () => { throw new Error("receipt temporarily unavailable"); }) as never;
      await renderComposerSend(restored).checkFailedSubmission(failed.id);
      expect(renderComposerSend(restored).failedSubmissions[0]).toMatchObject({ id: failed.id, retrying: false,
        acceptedTurn: { threadId, turnId: "accepted-turn", attemptId: "attempt-1" } });
      await renderComposerSend(restored).retryFailedSubmission(failed.id);
      expect(reloaded.client.request).toHaveBeenCalledTimes(1);
      expect(vi.mocked(reloaded.client.request).mock.calls[0][0]).toBe("turn/receipt/read");
      renderComposerSend(restored).dismissFailedSubmission(failed.id);
      await vi.waitFor(() => expect(renderComposerSend(restored).failedSubmissions).toEqual([]));
      expect(reloaded.client.request).toHaveBeenCalledTimes(1);
      expect(starts).toEqual([]);
    } finally { await runtime.close(); await reloaded?.runtime.close(); }
  });

  it.each(["resolve", "reject", "owner", "generation"] as const)("waits for the accepted recovery write before history (%s)", async ending => {
    const { runtime, client, starts } = await resumeRuntime();
    const threadId = runtime.getSnapshot().threadId;
    const failed: WorkspaceFailedSubmission = { id: "composer-accepted-write", content: "original", attachments: [], createdAt: 10, outcome: "unknown" };
    const context = contextFor(runtime, "new draft", [], [failed]);
    let release!: () => void; let reject!: (error: Error) => void;
    const held = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
    context.onFailedSubmissionsChange.mockImplementationOnce(() => held);
    client.supportsExperimental = capability => capability === "turnReceiptsV1";
    client.request = vi.fn(async (method: string) => {
      if (method === "turn/receipt/read") return { receipt: { threadId, turnId: "accepted-turn", status: "completed" } };
      if (method === "thread/read") return { messages: [], hasMoreBefore: false };
      throw new Error(`Unexpected mutation: ${method}`);
    }) as never;
    try {
      const checking = renderComposerSend(context).checkFailedSubmission(failed.id);
      await vi.waitFor(() => expect(context.onFailedSubmissionsChange).toHaveBeenCalledTimes(1));
      expect(vi.mocked(client.request).mock.calls.map(call => call[0])).toEqual(["turn/receipt/read"]);
      expect(renderComposerSend(context).failedSubmissions[0]).toMatchObject({ acceptedTurn: { threadId, turnId: "accepted-turn" } });
      if (ending === "owner") context.mountedRef.current = false;
      if (ending === "generation") runtime.clientGeneration += 1;
      if (ending === "reject") reject(new Error("accepted persistence uncertain")); else release();
      await checking;
      expect(vi.mocked(client.request).mock.calls.map(call => call[0])).toEqual(ending === "resolve" ? ["turn/receipt/read", "thread/read"] : ["turn/receipt/read"]);
      expect(context.setInput).not.toHaveBeenCalled();
      expect(starts).toEqual([]);
    } finally { release(); await runtime.close(); }
  });

  it.each(["turn", "attempt", "missing-attempt", "thread"] as const)("preserves an accepted binding when a fresh receipt conflicts (%s)", async mismatch => {
    const { runtime, client, starts } = await resumeRuntime();
    const threadId = runtime.getSnapshot().threadId;
    const acceptedTurn = { threadId: mismatch === "thread" ? "foreign-thread" : threadId, turnId: "accepted-turn", attemptId: "attempt-1" };
    const failed = { id: "composer-conflict", content: "original", attachments: [], createdAt: 10, outcome: "unknown" as const, acceptedTurn };
    const context = contextFor(runtime, "", [], [failed]);
    client.supportsExperimental = capability => capability === "turnReceiptsV1";
    client.request = vi.fn(async () => ({ receipt: { threadId, turnId: mismatch === "turn" ? "other-turn" : "accepted-turn", ...(mismatch === "missing-attempt" ? {} : { attemptId: mismatch === "attempt" ? "attempt-2" : "attempt-1" }), status: "completed" } })) as never;
    try {
      await renderComposerSend(context).checkFailedSubmission(failed.id);
      expect(renderComposerSend(context).failedSubmissions[0]).toMatchObject({ acceptedTurn, retrying: false });
      expect(vi.mocked(client.request).mock.calls.map(call => call[0])).toEqual(["turn/receipt/read"]);
      expect(starts).toEqual([]);
    } finally { await runtime.close(); }
  });

  it.each(["owner", "generation"] as const)("does not record an acceptance from a late receipt (%s)", async invalidation => {
    const { runtime, client } = await resumeRuntime();
    const threadId = runtime.getSnapshot().threadId;
    const failed: WorkspaceFailedSubmission = { id: "composer-late-receipt", content: "original", attachments: [], createdAt: 10, outcome: "unknown" };
    const context = contextFor(runtime, "new draft", [], [failed]);
    let release!: (value: unknown) => void;
    client.supportsExperimental = capability => capability === "turnReceiptsV1";
    client.request = vi.fn(async () => await new Promise(resolve => { release = resolve; })) as never;
    try {
      const checking = renderComposerSend(context).checkFailedSubmission(failed.id);
      await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));
      if (invalidation === "owner") context.mountedRef.current = false; else runtime.clientGeneration += 1;
      release({ receipt: { threadId, turnId: "accepted-turn", status: "completed" } });
      await checking;
      expect(renderComposerSend(context).failedSubmissions[0]).not.toHaveProperty("acceptedTurn");
      expect(context.onFailedSubmissionsChange.mock.calls.every(([items]) => !items?.some((item: WorkspaceFailedSubmission) => item.acceptedTurn))).toBe(true);
      expect(client.request).toHaveBeenCalledTimes(1);
      expect(context.setInput).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
  });

  it("keeps accepted attachment previews during checks and releases only the local preview once on explicit dismissal", async () => {
    const { runtime, client } = await resumeRuntime();
    const threadId = runtime.getSnapshot().threadId;
    const attachment = { path: "/owned/accepted.png", filename: "accepted.png", mimeType: "image/png", fileSize: 4,
      localPreviewUri: "blob:accepted-owned", ownsLocalPreviewUri: true };
    const failed = { id: "composer-accepted-preview", content: "original", attachments: [attachment], createdAt: 10,
      outcome: "unknown" as const, acceptedTurn: { threadId, turnId: "accepted-turn" } };
    const context = contextFor(runtime, "", [], [failed]);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    client.supportsExperimental = capability => capability === "turnReceiptsV1";
    client.request = vi.fn(async (method: string) => {
      if (method === "turn/receipt/read") return { receipt: { threadId, turnId: "accepted-turn", status: "completed" } };
      if (method === "thread/read") return { messages: [], hasMoreBefore: false };
      throw new Error(`Unexpected attachment mutation: ${method}`);
    }) as never;
    try {
      await renderComposerSend(context).checkFailedSubmission(failed.id);
      await renderComposerSend(context).checkFailedSubmission(failed.id);
      expect(revoke).not.toHaveBeenCalled();
      renderComposerSend(context).dismissFailedSubmission(failed.id);
      await vi.waitFor(() => expect(renderComposerSend(context).failedSubmissions).toHaveLength(0));
      await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
      renderComposerSend(context).dismissFailedSubmission(failed.id);
      expect(revoke.mock.calls).toEqual([["blob:accepted-owned"]]);
      expect(vi.mocked(client.request).mock.calls.map(call => call[0])).toEqual(["turn/receipt/read", "thread/read", "turn/receipt/read", "thread/read"]);
    } finally { await runtime.close(); }
  });

  it("keeps hydrated recovery and attachments until the exact accepted user is published in history", async () => {
    const { runtime, client, starts } = await resumeRuntime();
    const attachment = { path: "/owned/attachment.txt", filename: "attachment.txt", mimeType: "text/plain", fileSize: 4 };
    const failed: WorkspaceFailedSubmission = { id: "composer-reloaded-stable", content: "same text", attachments: [attachment], createdAt: 10, outcome: "unknown" };
    const context = contextFor(runtime, "new draft", [], [failed]);
    let release!: (value: unknown) => void;
    let history: { messages: Record<string, unknown>[]; hasMoreBefore: boolean } = { messages: [{ id: "peer", role: "user", content: "same text", turnId: "peer-turn", timestampMs: 10 }], hasMoreBefore: false };
    let hold = true;
    client.supportsExperimental = capability => capability === "turnReceiptsV1";
    client.request = vi.fn(async (method: string) => {
      if (method === "turn/receipt/read") return { receipt: { threadId: runtime.getSnapshot().threadId, turnId: "accepted-turn", status: "completed" } };
      if (method === "thread/read") return hold ? await new Promise(resolve => { release = resolve; }) : history;
      throw new Error(`Unexpected mutation: ${method}`);
    }) as never;
    try {
      const check = renderComposerSend(context).checkFailedSubmission(failed.id);
      await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("thread/read", expect.anything()));
      expect(renderComposerSend(context).failedSubmissions[0]).toMatchObject({ id: failed.id, attachments: [attachment] });
      release(history);
      await check;
      expect(vi.mocked(client.request).mock.calls.map(call => call[0])).toEqual(["turn/receipt/read", "thread/read"]);
      expect(renderComposerSend(context).failedSubmissions[0]).toMatchObject({ id: failed.id, outcome: "unknown", retrying: false, attachments: [attachment] });
      // A matching payload on a peer turn is not proof for the submitted ID.
      hold = false;
      history = { messages: [{ id: "accepted-user", role: "user", content: "same text", turnId: "accepted-turn", timestampMs: 11,
        blocks: [{ type: "attachment", attachment }] }], hasMoreBefore: false };
      await renderComposerSend(context).checkFailedSubmission(failed.id);
      expect(renderComposerSend(context).failedSubmissions).toHaveLength(0);
      expect(runtime.getSnapshot().messages.filter(message => message.turnId === "accepted-turn")).toHaveLength(1);
      expect(runtime.getSnapshot().messages.find(message => message.id === "accepted-user")?.attachments).toEqual([attachment]);
      await renderComposerSend(context).checkFailedSubmission(failed.id);
      expect(starts).toEqual([]);
      expect(context.setInput).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
  });

  it.each(["published", "read-failed"] as const)("reuses one receipt and one authoritative page for current uncertain acceptance (%s)", async outcome => {
    const { runtime, client } = await resumeRuntime();
    const id = "composer-current-uncertain";
    let receiptVisible = false;
    let startCount = 0;
    client.supportsExperimental = capability => capability === "turnReceiptsV1";
    client.request = vi.fn(async (method: string) => {
      if (method === "turn/start") {
        startCount += 1;
        throw new MobileRpcError("controlled lost start ACK", -1, "transport", "unknown");
      }
      if (method === "turn/receipt/read") return { receipt: receiptVisible ? {
        threadId: runtime.getSnapshot().threadId, turnId: "accepted-current", status: "completed",
      } : null };
      if (method === "thread/read") {
        if (outcome === "read-failed") throw new Error("controlled history unavailable");
        return { messages: [{ id: "server-original", role: "user", content: "original current send", clientMessageId: id,
          turnId: "accepted-current", timestampMs: 10 }], hasMoreBefore: false };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    }) as never;
    try {
      await runtime.send("original current send", [], undefined, { clientMessageId: id });
      expect(runtime.getSnapshot().sendAcceptanceUnknown).toBe(true);
      expect(runtime.uncertainSend?.clientMessageId).toBe(id);
      const context = contextFor(runtime, "", [], [{ id, content: "original current send", attachments: [], createdAt: 10, outcome: "unknown" }]);
      receiptVisible = true;
      vi.mocked(client.request).mockClear();
      await renderComposerSend(context).checkFailedSubmission(id);
      expect(vi.mocked(client.request).mock.calls.map(call => call[0])).toEqual(["turn/receipt/read", "thread/read"]);
      expect(startCount).toBe(1);
      if (outcome === "published") {
        expect(renderComposerSend(context).failedSubmissions).toEqual([]);
        expect(runtime.getSnapshot().messages.filter(message => message.role === "user")).toHaveLength(1);
        expect(runtime.getSnapshot().messages.find(message => message.role === "user")?.id).toBe("server-original");
      } else expect(renderComposerSend(context).failedSubmissions[0]).toMatchObject({ id, outcome: "unknown", retrying: false });
    } finally { await runtime.close(); }
  });

  it.each(["foreign-client", "foreign-turn", "missing-attachment", "duplicate"] as const)(
    "keeps hydrated recovery for an inexact authoritative history page (%s)", async mismatch => {
      const { runtime, client, starts } = await resumeRuntime();
      const attachment = { path: "/owned/exact.txt", filename: "exact.txt", mimeType: "text/plain", fileSize: 3 };
      const failed: WorkspaceFailedSubmission = { id: "composer-exact-identity", content: "repeated text", attachments: [attachment], createdAt: 10, outcome: "unknown" };
      const context = contextFor(runtime, "", [], [failed]);
      const message = { id: "server-user", role: "user", content: failed.content, timestampMs: 10,
        clientMessageId: mismatch === "foreign-client" ? "composer-peer" : failed.id,
        turnId: mismatch === "foreign-turn" ? "peer-turn" : "accepted-turn",
        blocks: mismatch === "missing-attachment" ? [] : [{ type: "attachment", attachment }],
      };
      client.supportsExperimental = capability => capability === "turnReceiptsV1";
      client.request = vi.fn(async (method: string) => {
        if (method === "turn/receipt/read") return { receipt: { threadId: runtime.getSnapshot().threadId, turnId: "accepted-turn", status: "completed" } };
        if (method === "thread/read") return { messages: mismatch === "duplicate" ? [message, { ...message, id: "duplicate-user" }] : [message] };
        throw new Error(`Unexpected mutation: ${method}`);
      }) as never;
      try {
        await renderComposerSend(context).checkFailedSubmission(failed.id);
        expect(renderComposerSend(context).failedSubmissions[0]).toMatchObject({ id: failed.id, attachments: [attachment], outcome: "unknown", retrying: false });
        expect(starts).toEqual([]);
        expect(runtime.getSnapshot().messages).toEqual([]);
      } finally { await runtime.close(); }
    },
  );

  it("keeps the same hydrated recovery when accepted history cannot be read", async () => {
    const { runtime, client, starts } = await resumeRuntime();
    const failed: WorkspaceFailedSubmission = { id: "composer-history-failed", content: "keep original", attachments: [], createdAt: 10, outcome: "unknown" };
    client.supportsExperimental = () => true;
    client.request = vi.fn(async (method: string) => {
      if (method === "turn/receipt/read") return { receipt: { threadId: runtime.getSnapshot().threadId, turnId: "accepted-turn", status: "running" } };
      throw new Error("controlled history read failure");
    }) as never;
    const context = contextFor(runtime, "", [], [failed]);
    try {
      await renderComposerSend(context).checkFailedSubmission(failed.id);
      expect(renderComposerSend(context).failedSubmissions[0]).toMatchObject({ id: failed.id, outcome: "unknown", retrying: false });
      expect(starts).toEqual([]);
    } finally { await runtime.close(); }
  });

  it("fences a held hydrated-history read when the composer owner changes", async () => {
    const { runtime, client, starts } = await resumeRuntime();
    const failed: WorkspaceFailedSubmission = { id: "composer-old-owner", content: "original", attachments: [], createdAt: 10, outcome: "unknown" };
    const context = contextFor(runtime, "", [], [failed]);
    const successor = await resumeRuntime();
    const successorContext = contextFor(successor.runtime, "owner B draft", []);
    let release!: (value: unknown) => void;
    client.supportsExperimental = capability => capability === "turnReceiptsV1";
    client.request = vi.fn(async (method: string) => {
      if (method === "turn/receipt/read") return { receipt: { threadId: runtime.getSnapshot().threadId, turnId: "accepted-turn", status: "completed" } };
      return await new Promise(resolve => { release = resolve; });
    }) as never;
    try {
      const checking = renderComposerSend(context).checkFailedSubmission(failed.id);
      await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("thread/read", expect.anything()));
      const validOwnerWrites = context.onFailedSubmissionsChange.mock.calls.length;
      expect(validOwnerWrites).toBe(1);
      renderComposerSend(successorContext);
      release({ messages: [{ id: "old-user", role: "user", content: failed.content, turnId: "accepted-turn", timestampMs: 10 }], hasMoreBefore: false });
      await checking;
      expect(runtime.getSnapshot().messages).toEqual([]);
      expect(context.onFailedSubmissionsChange).toHaveBeenCalledTimes(validOwnerWrites);
      expect(successorContext.onFailedSubmissionsChange).not.toHaveBeenCalled();
      expect(successorContext.setInput).not.toHaveBeenCalled();
      expect(renderComposerSend(successorContext).failedSubmissions).toEqual([]);
      expect(starts).toEqual([]);
    } finally { await runtime.close(); await successor.runtime.close(); }
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
      const persistedQueueCommits: Array<
        Pick<WorkspaceViewState, "queuedMessages" | "failedSubmissions">
      > = [];
      const onQueueCommit = vi.fn(async (
        value: Pick<WorkspaceViewState, "queuedMessages" | "failedSubmissions">
      ) => {
        persistedQueueCommits.push(value);
      });
      const queued = {
        id: "queued-retry-stable-id",
        content: "queued retry contract",
        attachments: [],
        createdAt: 123,
      };
      queue.enqueue(queued);
      const base = contextFor(runtime, "", queue.getSnapshot(), [], onQueueCommit);
      const composer = renderComposerSend(base);
      hookHarness.effects.at(-1)?.();
      await vi.waitFor(() =>
        expect(base.setQueueError).toHaveBeenCalledWith(
          expect.stringContaining("temporary queued-send rejection"),
        ),
      );
      expect(queue.first()).toEqual({ ...queued, permissionMode: "default" });
      expect(persistedQueueCommits[0]?.queuedMessages).toMatchObject([
        { id: queued.id, permissionMode: "default" },
      ]);

      hookHarness.effects = [];
      const retryContext = contextFor(
        runtime,
        "",
        queue.getSnapshot(),
        [],
        onQueueCommit,
      );
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
      expect(starts.every(({ params }) => params.permissionMode === undefined)).toBe(
        true,
      );
      expect(onQueueCommit).toHaveBeenCalledTimes(2);
      expect(persistedQueueCommits.map((value) => value.queuedMessages?.[0])).toEqual([
        { ...queued, permissionMode: "default" },
        { ...queued, permissionMode: "default" },
      ]);
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
