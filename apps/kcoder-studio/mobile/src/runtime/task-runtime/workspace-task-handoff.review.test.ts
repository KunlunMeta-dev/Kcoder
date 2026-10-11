// Real linked TaskRuntime factory + FakeClient RPC and AsyncStorage; no Provider or model transport.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  asyncValues: new Map<string, string>(),
  secureValues: new Map<string, string>(),
  setItemOverride: undefined as ((key: string, value: string) => Promise<void>) | undefined,
  rpcCalls: [] as Array<{ cwd: string; method: string; params: Record<string, unknown> }>,
  remoteReceipts: new Map<string, { scope: unknown; receipt: unknown }>(),
  remoteThreads: new Map<string, { id: string; cwd: string; title: string; status: string; createdAt: number; updatedAt: number }>(),
  remoteTurns: new Map<string, { threadId: string; turnId: string; status: string }>(),
  worktreeConversations: new Map<string, Record<string, unknown>>(),
  worktreeResultPath: undefined as string | undefined,
  dropNextThreadStartAck: false,
  hideNextCreationRead: false,
  threadStartGate: undefined as Promise<{ thread: { id: string; cwd: string; createdAt: number; updatedAt: number } }> | undefined,
  onThreadStart: undefined as (() => void) | undefined,
  dropNextTurnStartAck: false,
  failNextTurnReceiptRead: false,
  dropNextWorktreeLinkAck: false,
  refuseNextWorktreeLink: false,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getAllKeys: async () => [...fixture.asyncValues.keys()],
  getItem: async (key: string) => fixture.asyncValues.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    if (fixture.setItemOverride) return fixture.setItemOverride(key, value);
    fixture.asyncValues.set(key, value);
  },
  removeItem: async (key: string) => { fixture.asyncValues.delete(key); },
  multiRemove: async (keys: string[]) => { for (const key of keys) fixture.asyncValues.delete(key); },
} }));

vi.mock("@/storage/secure", () => ({
  getSecureValue: async (key: string) => fixture.secureValues.get(key) ?? null,
  setSecureValue: async (key: string, value: string) => { fixture.secureValues.set(key, value); },
  deleteSecureValue: async (key: string) => { fixture.secureValues.delete(key); },
}));

vi.mock("react-native", async importOriginal => {
  const actual = await importOriginal<typeof import("react-native")>();
  return { ...actual, Platform: { ...actual.Platform, OS: "android" } };
});

vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: vi.fn(async () => undefined),
  gatewaySessionExpired: vi.fn(async () => false),
}));

import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { WORKSPACE_READ_V2, WORKSPACE_SCOPE_V2, workspaceParamsDigestV2, type WorkspaceMutationMethodV2 } from "@/protocol/workspace-operation-receipts-v2";
import { TaskRuntime } from "./core";
import { taskRuntimeTestHelpers } from "./connectionFactory";
import { TaskRuntimeRegistry } from "./registry";
import { FakeClient, profile as fixtureProfile, server as fixtureServer } from "./fixture.test-support";
import {
  acknowledgeWorkspaceOperationV2,
  confirmWorkspaceTaskRoute,
  loadWorkspaceTaskHandoff,
  reserveWorkspaceTaskHandoff,
} from "@/storage/pending-workspace-operation-v2";
import { persistProfiles } from "@/storage/profile-store";
import { openWorkspaceWithReceipt, prepareManagedWorktreeWithReceipt } from "./workspaces";
import { readWorkspaceTaskHandoff, type WorkspaceTaskHandoff } from "@/storage/pending-thread-creation";
import { retryCreationCleanup } from "./factories";

const profile: GatewayProfile = {
  ...fixtureProfile,
  id: "workspace-task-handoff-runtime-review",
  authorizationGeneration: "handoff-runtime-review-generation",
  deviceId: "handoff-runtime-review-device",
  authMode: "legacy",
};

const server: KCoderServer = {
  ...fixtureServer,
  id: "handoff-runtime-review-target",
  workspacePath: "/workspace/repository",
};
const serverWorkspacePath = (() => {
  const path = server.workspacePath;
  if (!path) throw new Error("runtime review fixture requires a server workspace path");
  return path;
})();
const threadTimestamp = 1_760_000_000_000;

const sourceRoot = "1".repeat(64);
const taskRoot = "2".repeat(64);
const workspaceFamily = "3".repeat(64);
const scopeAtSource = {
  version: 2 as const,
  rootId: sourceRoot,
  scopeId: "4".repeat(64),
  familyId: workspaceFamily,
};
const scopeAtTask = {
  version: 2 as const,
  rootId: taskRoot,
  scopeId: "5".repeat(64),
  familyId: workspaceFamily,
};

function scopeFor(cwd: string) {
  return cwd === serverWorkspacePath ? scopeAtSource : scopeAtTask;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function associationKey(params: Record<string, unknown>): string {
  const conversation = (params.conversation ?? {}) as Record<string, unknown>;
  return JSON.stringify([params.deviceId, params.path, conversation.taskId, conversation.threadId]);
}

function makeClient(cwd: string): FakeClient {
  const client = new FakeClient([]);
  client.supportsExperimental = capability => [
    "workspaceOperationReceiptsV2",
    "threadCreationReceiptsV1",
    "turnReceiptsV1",
  ].includes(capability);
  client.request = vi.fn(async (method: string, rawParams: Record<string, unknown> = {}) => {
    const params = { ...rawParams };
    const scope = scopeFor(cwd);
    fixture.rpcCalls.push({ cwd, method, params });

    if (method === WORKSPACE_SCOPE_V2) return scope;
    if (method === WORKSPACE_READ_V2) {
      const prior = fixture.remoteReceipts.get(String(params.clientRequestId ?? ""));
      return { scope, receipt: prior?.receipt ?? null };
    }
    if (method === "runtime.workspaces.openV2" || method === "runtime.workspaces.prepareV2" || method === "runtime.worktrees.prepareV2") {
      const mutation = method as WorkspaceMutationMethodV2;
      const id = String(params.clientRequestId ?? "");
      const resultPath = mutation === "runtime.worktrees.prepareV2"
        ? fixture.worktreeResultPath ?? `${String(params.sourcePath)}/.worktrees/${String(params.worktreeId)}`
        : String(params.workspacePath ?? "/workspace/repository");
      const receipt = {
        clientRequestId: id,
        method: mutation,
        paramsDigest: workspaceParamsDigestV2(mutation, params),
        status: "ready",
        workspacePath: resultPath,
      };
      fixture.remoteReceipts.set(id, { scope, receipt });
      const result = mutation === "runtime.worktrees.prepareV2"
        ? { success: true, path: resultPath }
        : mutation === "runtime.workspaces.prepareV2"
          ? { mapping: { workspacePath: resultPath } }
          : { workspacePath: resultPath };
      return { scope, receipt, result };
    }
    if (method === "thread/start") {
      const requestId = String(params.clientRequestId ?? "missing-id");
      const thread = fixture.remoteThreads.get(requestId) ?? {
        id: `thread-${requestId}`,
        cwd: String(params.cwd ?? cwd),
        title: "handoff task",
        status: "idle",
        createdAt: threadTimestamp,
        updatedAt: threadTimestamp,
      };
      fixture.remoteThreads.set(requestId, thread);
      fixture.onThreadStart?.();
      fixture.onThreadStart = undefined;
      if (fixture.threadStartGate) return fixture.threadStartGate;
      if (fixture.dropNextThreadStartAck) {
        fixture.dropNextThreadStartAck = false;
        return Promise.reject(new Error("thread/start accepted but reply was lost"));
      }
      return { thread };
    }
    if (method === "thread/creation/read") {
      if (fixture.hideNextCreationRead) {
        fixture.hideNextCreationRead = false;
        return { receipt: null };
      }
      const requestId = String(params.clientRequestId ?? "");
      const thread = fixture.remoteThreads.get(requestId);
      return thread
        ? { receipt: { status: "ready", threadId: thread.id, thread } }
        : { receipt: null };
    }
    if (method === "thread/resume") {
      const threadId = String(params.threadId ?? "");
      return { thread: { id: threadId, cwd: String(params.cwd ?? cwd), title: "handoff task", status: "idle", createdAt: threadTimestamp, updatedAt: threadTimestamp } };
    }
    if (method === "thread/read") {
      const threadId = String(params.threadId ?? "");
      return { thread: { id: threadId, cwd, title: "handoff task", status: "idle", createdAt: threadTimestamp, updatedAt: threadTimestamp }, messages: [], hasMoreBefore: false };
    }
    if (method === "thread/metadata/update") return {};
    if (method === "runtime.worktrees.conversations.link") {
      const key = associationKey(params);
      if (fixture.refuseNextWorktreeLink) {
        fixture.refuseNextWorktreeLink = false;
        return { accepted: false, path: params.path };
      }
      fixture.worktreeConversations.set(key, params.conversation as Record<string, unknown>);
      if (fixture.dropNextWorktreeLinkAck) {
        fixture.dropNextWorktreeLinkAck = false;
        return Promise.reject(new Error("conversation upsert accepted but reply was lost"));
      }
      return { accepted: true, path: params.path };
    }
    if (method === "turn/start") {
      const clientMessageId = String(params.clientMessageId ?? "");
      const receiptKey = JSON.stringify([params.threadId, clientMessageId]);
      const turn = { threadId: String(params.threadId ?? ""), turnId: `turn-${clientMessageId}`, status: "running" };
      fixture.remoteTurns.set(receiptKey, turn);
      if (fixture.dropNextTurnStartAck) {
        fixture.dropNextTurnStartAck = false;
        return Promise.reject(new Error("turn/start accepted but reply was lost"));
      }
      return { turn: { id: turn.turnId, status: turn.status } };
    }
    if (method === "turn/receipt/read") {
      if (fixture.failNextTurnReceiptRead) {
        fixture.failNextTurnReceiptRead = false;
        return Promise.reject(new Error("turn receipt temporarily unavailable"));
      }
      const key = JSON.stringify([params.threadId, params.clientMessageId]);
      const receipt = fixture.remoteTurns.get(key);
      return receipt
        ? { receipt: { ...receipt, clientMessageId: params.clientMessageId } }
        : { receipt: null };
    }
    return {};
  }) as never;
  return client;
}

type TaskCreationInput = Parameters<typeof TaskRuntime.create>[0];
type TaskInputOptions = { worktree?: boolean; prompt?: string; worktreeResultPath?: string };

async function createHandoff(options: TaskInputOptions = {}): Promise<{
  handoff: WorkspaceTaskHandoff;
  input: TaskCreationInput;
  sourceReceiptId: string;
  workspaceReceipt: Awaited<ReturnType<typeof openWorkspaceWithReceipt>>["receipt"];
}> {
  if (options.worktreeResultPath) fixture.worktreeResultPath = options.worktreeResultPath;
  const prompt = options.prompt ?? "continue the original task";
  const confirmed = options.worktree
    ? await prepareManagedWorktreeWithReceipt(profile, server, serverWorkspacePath, "feature/handoff")
    : await openWorkspaceWithReceipt(profile, server, "/workspace/task");
  const linkedInput = {
    cwd: confirmed.path,
    prompt,
    model: "review-model",
    ...(options.worktree ? { managedWorktreeSourcePath: serverWorkspacePath } : {}),
  };
  const handoff = await reserveWorkspaceTaskHandoff(profile, server, confirmed.receipt, linkedInput);
  return {
    handoff,
    input: { ...linkedInput, profile, server, workspaceHandoff: handoff },
    sourceReceiptId: confirmed.receipt.id,
    workspaceReceipt: confirmed.receipt,
  };
}

function calls(method: string) {
  return fixture.rpcCalls.filter(call => call.method === method);
}

beforeEach(async () => {
  fixture.asyncValues.clear();
  fixture.secureValues.clear();
  fixture.setItemOverride = undefined;
  fixture.rpcCalls.length = 0;
  fixture.remoteReceipts.clear();
  fixture.remoteThreads.clear();
  fixture.remoteTurns.clear();
  fixture.worktreeConversations.clear();
  fixture.worktreeResultPath = undefined;
  fixture.dropNextThreadStartAck = false;
  fixture.hideNextCreationRead = false;
  fixture.threadStartGate = undefined;
  fixture.onThreadStart = undefined;
  fixture.dropNextTurnStartAck = false;
  fixture.failNextTurnReceiptRead = false;
  fixture.dropNextWorktreeLinkAck = false;
  fixture.refuseNextWorktreeLink = false;
  taskRuntimeTestHelpers.setConnector(async (_profile, _server, cwd) => makeClient(cwd ?? serverWorkspacePath) as never);
  await persistProfiles([profile], profile.id);
});

afterEach(() => {
  taskRuntimeTestHelpers.resetConnector();
  fixture.setItemOverride = undefined;
  fixture.threadStartGate = undefined;
  retryCreationCleanup(32);
  vi.restoreAllMocks();
});

it("reloads the linked locator after an unknown start reply and recovers without another thread/start", async () => {
  fixture.dropNextThreadStartAck = true;
  fixture.hideNextCreationRead = true;
  const { handoff, sourceReceiptId } = await createHandoff();

  await expect(TaskRuntime.create({
    ...(await readWorkspaceTaskHandoff(handoff)).linked!.input,
    profile,
    server,
    workspaceHandoff: handoff,
  })).rejects.toThrow("原任务创建结果仍未知");
  const afterUnknown = await readWorkspaceTaskHandoff(handoff);
  expect(afterUnknown.dispatched).toBe(true);
  expect(afterUnknown.linked?.threadPhase).toBe("unknown");
  expect(calls("thread/start")).toHaveLength(1);
  expect(calls("thread/start")[0].params.clientRequestId).toBe(handoff.clientRequestId);
  expect(calls("thread/creation/read")).toHaveLength(1);
  expect(calls("thread/creation/read")[0].params.clientRequestId).toBe(handoff.clientRequestId);

  // Simulate a fresh route owner rebuilding its factory input from durable storage.
  const loaded = await loadWorkspaceTaskHandoff(profile, server, { receiptId: sourceReceiptId });
  expect(loaded?.handle).toEqual(handoff);
  const recoveredInput = {
    ...loaded!.value.linked!.input,
    profile,
    server,
    workspaceHandoff: loaded!.handle,
  };
  const runtime = await TaskRuntime.create(recoveredInput);
  try {
    expect(runtime.getSnapshot().threadId).toBe(`thread-${handoff.clientRequestId}`);
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("thread/creation/read")).toHaveLength(2);
    expect(calls("thread/creation/read").every(call => call.params.clientRequestId === handoff.clientRequestId)).toBe(true);
    expect(calls("turn/start")).toHaveLength(1);
    expect(calls("turn/start")[0].params.clientMessageId).toBe(`${handoff.clientRequestId}-initial-turn`);
    expect(calls("turn/start")[0].params.input).toEqual([{ type: "text", text: "continue the original task" }]);
  } finally {
    runtime.close();
  }
});

it("leaves a prepared initial turn unsent when its sent checkpoint fails, then retries that same initial-turn ID", async () => {
  const { handoff, input } = await createHandoff();
  let failedCheckpoint = false;
  fixture.setItemOverride = async (key, raw) => {
    if (key === handoff.key) {
      const value = JSON.parse(raw) as { linked?: { turn?: { phase?: string } } };
      if (!failedCheckpoint && value.linked?.turn?.phase === "sent") {
        failedCheckpoint = true;
        throw new Error("initial turn checkpoint unavailable");
      }
    }
    fixture.asyncValues.set(key, raw);
  };

  await expect(TaskRuntime.create(input)).rejects.toThrow("initial turn checkpoint unavailable");
  const prepared = await readWorkspaceTaskHandoff(handoff);
  expect(prepared.linked?.threadPhase).toBe("ready");
  expect(prepared.linked?.turn.phase).toBe("prepared");
  expect(calls("thread/start")).toHaveLength(1);
  expect(calls("turn/start")).toHaveLength(0);

  fixture.setItemOverride = undefined;
  const runtime = await TaskRuntime.create(input);
  try {
    expect(runtime.getSnapshot().threadId).toBe(prepared.threadId);
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("turn/start")).toHaveLength(1);
    expect(calls("turn/start")[0].params.clientMessageId).toBe(`${handoff.clientRequestId}-initial-turn`);
  } finally {
    runtime.close();
  }
});

it("reads the exact initial-turn receipt after a lost ACK instead of starting that turn again", async () => {
  fixture.dropNextTurnStartAck = true;
  const { handoff, input } = await createHandoff();
  const firstRuntime = await TaskRuntime.create(input);
  expect(firstRuntime.getSnapshot().sendAcceptanceUnknown).toBe(true);
  expect(calls("thread/start")).toHaveLength(1);
  expect(calls("turn/start")).toHaveLength(1);
  expect(calls("turn/start")[0].params.clientMessageId).toBe(`${handoff.clientRequestId}-initial-turn`);
  expect((await readWorkspaceTaskHandoff(handoff)).linked?.turn.phase).toBe("unknown");
  firstRuntime.close();

  const recoveredRuntime = await TaskRuntime.create(input);
  try {
    expect(recoveredRuntime.getSnapshot().threadId).toBe(`thread-${handoff.clientRequestId}`);
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("turn/start")).toHaveLength(1);
    expect(calls("turn/receipt/read").length).toBeGreaterThanOrEqual(1);
    expect(calls("turn/receipt/read").every(call =>
      call.params.threadId === `thread-${handoff.clientRequestId}` &&
      call.params.clientMessageId === `${handoff.clientRequestId}-initial-turn`,
    )).toBe(true);
    expect((await readWorkspaceTaskHandoff(handoff)).linked?.turn.phase).toBe("accepted");
  } finally {
    recoveredRuntime.close();
  }
});

it("keeps the link when receipt reads succeed before runtime projection, then removes it after the exact turn is applied", async () => {
  fixture.dropNextTurnStartAck = true;
  const { handoff, input, workspaceReceipt } = await createHandoff();
  await expect(acknowledgeWorkspaceOperationV2(workspaceReceipt, { profile, server })).resolves.toBe("consumed");
  const runtime = await TaskRuntime.create(input);
  try {
    const clientMessageId = `${handoff.clientRequestId}-initial-turn`;
    const threadId = `thread-${handoff.clientRequestId}`;
    expect(runtime.getSnapshot().sendAcceptanceUnknown).toBe(true);
    expect(runtime.uncertainSend).toMatchObject({ threadId, clientMessageId });
    expect(calls("turn/start")).toHaveLength(1);

    fixture.failNextTurnReceiptRead = true;
    await expect(runtime.reconcileSendAcceptance()).rejects.toThrow("turn receipt temporarily unavailable");
    expect(runtime.getSnapshot().sendAcceptanceUnknown).toBe(true);
    expect(runtime.uncertainSend).toMatchObject({ threadId, clientMessageId });
    const afterReadFailure = await readWorkspaceTaskHandoff(handoff);
    expect(afterReadFailure.linked?.turn.phase).toBe("unknown");
    expect(afterReadFailure.linked?.routeConfirmed).toBe(false);
    expect(fixture.asyncValues.has(handoff.key)).toBe(true);
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("turn/start")).toHaveLength(1);

    // A successful read in the route confirmer is still not enough while this
    // exact Runtime remains acceptance-unknown.
    await expect(confirmWorkspaceTaskRoute(
      profile,
      server,
      handoff,
      threadId,
      () => !runtime.isDisposed() && !runtime.getSnapshot().sendAcceptanceUnknown,
    )).resolves.toBe(false);
    const afterUnprojectedRead = await readWorkspaceTaskHandoff(handoff);
    expect(afterUnprojectedRead.linked?.turn.phase).toBe("unknown");
    expect(afterUnprojectedRead.linked?.routeConfirmed).toBe(false);
    expect(fixture.asyncValues.has(handoff.key)).toBe(true);

    await runtime.reconcileSendAcceptance();
    expect(runtime.getSnapshot().sendAcceptanceUnknown).toBe(false);
    expect(runtime.getSnapshot().activeTurnId).toBe(`turn-${clientMessageId}`);
    expect(runtime.getSnapshot().running).toBe(true);
    expect(runtime.uncertainSend).toBeNull();
    expect(fixture.asyncValues.has(handoff.key)).toBe(true);

    const currentAfterProjection = () =>
      !runtime.isDisposed() &&
      runtime.getSnapshot().threadId === threadId &&
      runtime.getSnapshot().sendAcceptanceUnknown === false &&
      runtime.getSnapshot().activeTurnId === `turn-${clientMessageId}`;
    await expect(confirmWorkspaceTaskRoute(
      profile,
      server,
      handoff,
      threadId,
      currentAfterProjection,
    )).resolves.toBe(true);
    expect(fixture.asyncValues.has(handoff.key)).toBe(false);
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("turn/start")).toHaveLength(1);
    expect(calls("turn/receipt/read").length).toBeGreaterThanOrEqual(2);
    expect(calls("turn/receipt/read").every(call =>
      call.params.threadId === threadId && call.params.clientMessageId === clientMessageId,
    )).toBe(true);
  } finally {
    runtime.close();
  }
});

it("retries a lost worktree conversation-link ACK with the same task identity and payload", async () => {
  fixture.dropNextWorktreeLinkAck = true;
  const { handoff, input } = await createHandoff({ worktree: true });
  const prepareCount = calls("runtime.worktrees.prepareV2").length;

  await expect(TaskRuntime.create(input)).rejects.toThrow("conversation upsert accepted but reply was lost");
  const linked = await readWorkspaceTaskHandoff(handoff);
  expect(linked.linked?.threadPhase).toBe("ready");
  expect(linked.linked?.worktreeLink?.confirmed).toBe(false);
  expect(linked.linked?.turn.phase).toBe("prepared");
  expect(fixture.worktreeConversations.size).toBe(1);

  const runtime = await TaskRuntime.create(input);
  try {
    expect(runtime.getSnapshot().threadId).toBe(linked.threadId);
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("runtime.worktrees.prepareV2")).toHaveLength(prepareCount);
    expect(calls("runtime.worktrees.conversations.link")).toHaveLength(2);
    expect(calls("runtime.worktrees.conversations.link")[0].params).toEqual(
      calls("runtime.worktrees.conversations.link")[1].params,
    );
    const linkParams = calls("runtime.worktrees.conversations.link")[1].params;
    expect(linkParams.deviceId).toBe(server.id);
    expect((linkParams.conversation as Record<string, unknown>).taskId).toBe(linked.threadId);
    expect((linkParams.conversation as Record<string, unknown>).threadId).toBe(linked.threadId);
    expect(fixture.worktreeConversations.size).toBe(1);
    expect(calls("turn/start")).toHaveLength(1);
    expect(calls("turn/start")[0].params.clientMessageId).toBe(`${handoff.clientRequestId}-initial-turn`);
    expect((await readWorkspaceTaskHandoff(handoff)).linked?.worktreeLink?.confirmed).toBe(true);
  } finally {
    runtime.close();
  }
});

it("preserves the ready thread after a definitive worktree-link refusal and retries only that link", async () => {
  const { handoff, input } = await createHandoff({ worktree: true });
  const prepareCount = calls("runtime.worktrees.prepareV2").length;
  fixture.refuseNextWorktreeLink = true;

  await expect(TaskRuntime.create(input)).rejects.toThrow("原任务 worktree 关联尚未确认");
  const pending = await readWorkspaceTaskHandoff(handoff);
  expect(pending.threadId).toBe(`thread-${handoff.clientRequestId}`);
  expect(pending.linked?.threadPhase).toBe("ready");
  expect(pending.linked?.worktreeLink?.confirmed).toBe(false);
  expect(pending.linked?.turn.phase).toBe("prepared");
  expect(fixture.worktreeConversations.size).toBe(0);
  expect(calls("thread/start")).toHaveLength(1);
  expect(calls("thread/delete")).toHaveLength(0);
  expect(calls("runtime.worktrees.prepareV2")).toHaveLength(prepareCount);
  expect(calls("runtime.worktrees.conversations.link")).toHaveLength(1);
  expect(calls("turn/start")).toHaveLength(0);

  const runtime = await TaskRuntime.create(input);
  try {
    expect(runtime.getSnapshot().threadId).toBe(pending.threadId);
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("thread/delete")).toHaveLength(0);
    expect(calls("runtime.worktrees.prepareV2")).toHaveLength(prepareCount);
    expect(calls("runtime.worktrees.conversations.link")).toHaveLength(2);
    expect(fixture.worktreeConversations.size).toBe(1);
    expect(calls("turn/start")).toHaveLength(1);
    expect(calls("turn/start")[0].params.clientMessageId).toBe(`${handoff.clientRequestId}-initial-turn`);
  } finally {
    runtime.close();
  }
});

it("keeps the ready thread when persisting its first worktree-link payload fails before dispatch", async () => {
  const { handoff, input } = await createHandoff({ worktree: true });
  const prepareCount = calls("runtime.worktrees.prepareV2").length;
  let rejectedLinkCheckpoint = false;
  fixture.setItemOverride = async (key, raw) => {
    if (key === handoff.key) {
      const value = JSON.parse(raw) as { linked?: { worktreeLink?: { confirmed?: boolean } } };
      if (!rejectedLinkCheckpoint && value.linked?.worktreeLink?.confirmed === false) {
        rejectedLinkCheckpoint = true;
        throw new Error("worktree link checkpoint unavailable");
      }
    }
    fixture.asyncValues.set(key, raw);
  };

  await expect(TaskRuntime.create(input)).rejects.toThrow("worktree link checkpoint unavailable");
  const ready = await readWorkspaceTaskHandoff(handoff);
  expect(rejectedLinkCheckpoint).toBe(true);
  expect(ready.threadId).toBe(`thread-${handoff.clientRequestId}`);
  expect(ready.linked?.threadPhase).toBe("ready");
  expect(ready.linked?.worktreeLink).toBeUndefined();
  expect(ready.linked?.turn.phase).toBe("prepared");
  expect(calls("thread/start")).toHaveLength(1);
  expect(calls("runtime.worktrees.prepareV2")).toHaveLength(prepareCount);
  expect(calls("runtime.worktrees.conversations.link")).toHaveLength(0);
  expect(calls("turn/start")).toHaveLength(0);

  fixture.setItemOverride = undefined;
  const recovered = await TaskRuntime.create(input);
  try {
    expect(recovered.getSnapshot().threadId).toBe(ready.threadId);
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("runtime.worktrees.prepareV2")).toHaveLength(prepareCount);
    expect(calls("runtime.worktrees.conversations.link")).toHaveLength(1);
    expect(calls("runtime.worktrees.conversations.link")[0].params.deviceId).toBe(server.id);
    expect((calls("runtime.worktrees.conversations.link")[0].params.conversation as Record<string, unknown>).taskId).toBe(ready.threadId);
    expect(calls("turn/start")).toHaveLength(1);
    expect(calls("turn/start")[0].params.clientMessageId).toBe(`${handoff.clientRequestId}-initial-turn`);
    expect((await readWorkspaceTaskHandoff(handoff)).linked?.worktreeLink?.confirmed).toBe(true);
  } finally {
    recovered.close();
  }
});

it("lets a successor adopt the same linked creation after its owner releases, while a different receipt cannot share that flight", async () => {
  const { handoff, input } = await createHandoff();
  let resolveThreadStart!: (value: { thread: { id: string; cwd: string; createdAt: number; updatedAt: number } }) => void;
  fixture.threadStartGate = new Promise(resolve => { resolveThreadStart = resolve; });
  const startReached = deferred<void>();
  fixture.onThreadStart = () => startReached.resolve(undefined);
  const registry = new TaskRuntimeRegistry();
  const firstOwner = TaskRuntime.claimCreation(input, registry);
  let successor: ReturnType<typeof TaskRuntime.claimCreation> | undefined;
  let mismatched: ReturnType<typeof TaskRuntime.claimCreation> | undefined;
  try {
    await startReached.promise;
    successor = TaskRuntime.claimCreation({ ...input }, registry);
    expect(successor.result).toBe(firstOwner.result);

    const otherReceipt = { ...handoff, receiptId: `${handoff.receiptId}-different` };
    mismatched = TaskRuntime.claimCreation({ ...input, workspaceHandoff: otherReceipt }, registry);
    expect(mismatched.result).not.toBe(firstOwner.result);
    await expect(mismatched.result).rejects.toThrow();
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("turn/start")).toHaveLength(0);
    mismatched.release();
    mismatched = undefined;

    firstOwner.release();
    resolveThreadStart({ thread: { id: `thread-${handoff.clientRequestId}`, cwd: input.cwd, createdAt: threadTimestamp, updatedAt: threadTimestamp } });
    const runtime = await successor.result;
    expect(successor.adopt(registry, profile.id, server.id)).toBe(true);
    expect(runtime.isDisposed()).toBe(false);
    expect(registry.get(profile.id, server.id, runtime.getSnapshot().threadId)).toBe(runtime);
    expect(calls("thread/start")).toHaveLength(1);
    expect(calls("thread/start")[0].params.clientRequestId).toBe(handoff.clientRequestId);
    expect(calls("turn/start")).toHaveLength(1);
    successor.release();
    successor = undefined;
    registry.removeProfile(profile.id);
  } finally {
    resolveThreadStart?.({ thread: { id: `thread-${handoff.clientRequestId}`, cwd: input.cwd, createdAt: threadTimestamp, updatedAt: threadTimestamp } });
    firstOwner.release();
    successor?.release();
    mismatched?.release();
    fixture.threadStartGate = undefined;
    registry.removeProfile(profile.id);
  }
});
