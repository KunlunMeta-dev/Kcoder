import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  asyncValues: new Map<string, string>(),
  secureValues: new Map<string, string>(),
  setItemOverride: undefined as ((key: string, value: string) => Promise<void>) | undefined,
  rpcCalls: [] as Array<{ cwd: string; method: string; params: Record<string, unknown> }>,
  remoteReceipts: new Map<string, { scope: unknown; receipt: unknown }>(),
  worktreeResultPath: undefined as string | undefined,
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

vi.mock("./secure", () => ({
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
import {
  WORKSPACE_READ_V2,
  WORKSPACE_SCOPE_V2,
  workspaceParamsDigestV2,
  type WorkspaceMutationMethodV2,
} from "@/protocol/workspace-operation-receipts-v2";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime/connectionFactory";
import { FakeClient, profile as fixtureProfile, server as fixtureServer } from "@/runtime/task-runtime/fixture.test-support";
import { ProfileCoordinator } from "@/state/profile-coordinator";
import { removeGatewayProfile } from "@/state/remove-gateway-profile";
import {
  acknowledgeWorkspaceOperationV2,
  loadWorkspaceTaskHandoff,
  reserveWorkspaceTaskHandoff,
} from "./pending-workspace-operation-v2";
import {
  pendingThreadCreationKey,
  readWorkspaceTaskHandoff,
  startWorkspaceTaskHandoffRpc,
  updateWorkspaceTaskHandoff,
  waitForPendingThreadCreationWrites,
} from "./pending-thread-creation";
import { PROFILE_INDEX_KEY, persistProfiles } from "./profile-store";
import { openWorkspaceWithReceipt, prepareManagedWorktreeWithReceipt } from "@/runtime/task-runtime/workspaces";

const profile: GatewayProfile = {
  ...fixtureProfile,
  id: "workspace-task-handoff-storage-review",
  authorizationGeneration: "handoff-storage-review-generation",
  deviceId: "handoff-storage-review-device",
  authMode: "legacy",
};

const server: KCoderServer = {
  ...fixtureServer,
  id: "handoff-storage-review-target",
  workspacePath: "/workspace/repository",
};
const serverWorkspacePath = (() => {
  const path = server.workspacePath;
  if (!path) throw new Error("storage review fixture requires a server workspace path");
  return path;
})();

const sourceRoot = "a".repeat(64);
const taskRoot = "b".repeat(64);
const workspaceFamily = "c".repeat(64);
const scopeAtSource = {
  version: 2 as const,
  rootId: sourceRoot,
  scopeId: "d".repeat(64),
  familyId: workspaceFamily,
};
const scopeAtTask = {
  version: 2 as const,
  rootId: taskRoot,
  scopeId: "e".repeat(64),
  familyId: workspaceFamily,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function scopeFor(cwd: string) {
  return cwd === serverWorkspacePath ? scopeAtSource : scopeAtTask;
}

function makeClient(cwd: string): FakeClient {
  const client = new FakeClient([]);
  client.supportsExperimental = capability => capability === "workspaceOperationReceiptsV2";
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
    return {};
  }) as never;
  return client;
}

async function prepareReceipt(gitRef = "main") {
  return prepareManagedWorktreeWithReceipt(profile, server, serverWorkspacePath, gitRef);
}

async function reserve(receipt: Awaited<ReturnType<typeof prepareReceipt>>, prompt = "inspect the worktree") {
  return reserveWorkspaceTaskHandoff(profile, server, receipt.receipt, {
    cwd: receipt.path,
    prompt,
    model: "review-model",
    managedWorktreeSourcePath: serverWorkspacePath,
  });
}

function expectNoTaskStartOrTurn(): void {
  expect(fixture.rpcCalls.filter(call => call.method === "thread/start" || call.method === "turn/start")).toEqual([]);
}

beforeEach(async () => {
  fixture.asyncValues.clear();
  fixture.secureValues.clear();
  fixture.setItemOverride = undefined;
  fixture.rpcCalls.length = 0;
  fixture.remoteReceipts.clear();
  fixture.worktreeResultPath = undefined;
  taskRuntimeTestHelpers.setConnector(async (_profile, _server, cwd) => makeClient(cwd ?? serverWorkspacePath) as never);
  await persistProfiles([profile], profile.id);
  expect(fixture.secureValues.has(PROFILE_INDEX_KEY)).toBe(true);
});

afterEach(() => {
  taskRuntimeTestHelpers.resetConnector();
  vi.restoreAllMocks();
});

it("does not expose a handoff until its linked record is durable, and a failed link write cannot start a task", async () => {
  const receipt = await prepareReceipt();
  const key = pendingThreadCreationKey(profile, server, receipt.path);

  fixture.setItemOverride = async (requestedKey, value) => {
    if (requestedKey === key) throw new Error("handoff storage unavailable");
    fixture.asyncValues.set(requestedKey, value);
  };
  await expect(reserve(receipt)).rejects.toThrow("handoff storage unavailable");
  expect(fixture.asyncValues.has(key)).toBe(false);
  expectNoTaskStartOrTurn();

  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  fixture.setItemOverride = async (requestedKey, value) => {
    if (requestedKey === key) {
      writeStarted.resolve(undefined);
      await releaseWrite.promise;
    }
    fixture.asyncValues.set(requestedKey, value);
  };
  let returned = false;
  const reservation = reserve(receipt).then(value => {
    returned = true;
    return value;
  });
  await writeStarted.promise;
  expect(returned).toBe(false);
  expect(fixture.asyncValues.has(key)).toBe(false);
  expectNoTaskStartOrTurn();

  releaseWrite.resolve(undefined);
  const handoff = await reservation;
  const stored = await readWorkspaceTaskHandoff(handoff);
  expect(stored.clientRequestId).toBe(handoff.clientRequestId);
  expect(stored.linked?.receipt.id).toBe(receipt.receipt.id);
  expect(stored.linked?.turn.clientMessageId).toBe(`${handoff.clientRequestId}-initial-turn`);
});

it("keeps a linked task after its workspace ACK is consumed and blocks profile removal until task route completion", async () => {
  const receipt = await prepareReceipt();
  const handoff = await reserve(receipt);

  await expect(acknowledgeWorkspaceOperationV2(receipt.receipt, { profile, server })).resolves.toBe("consumed");
  const recovered = await loadWorkspaceTaskHandoff(profile, server, { receiptId: receipt.receipt.id });
  expect(recovered?.handle).toEqual(handoff);
  expect(await readWorkspaceTaskHandoff(handoff)).toMatchObject({
    clientRequestId: handoff.clientRequestId,
    linked: { receipt: { id: receipt.receipt.id }, turn: { phase: "prepared" }, routeConfirmed: false },
  });

  const coordinator = new ProfileCoordinator();
  coordinator.hydrate({ profiles: [profile], activeId: profile.id });
  const persist = vi.fn(async () => undefined);
  const cleanupProfileState = vi.fn(async () => undefined);
  const effects = {
    setProfiles: vi.fn(),
    setActiveId: vi.fn(),
    removeProfileRuntimes: vi.fn(),
    clearRuntime: vi.fn(),
    markProfileStateRemoval: vi.fn(() => 1),
  };
  await expect(removeGatewayProfile(profile.id, {
    coordinator,
    persist,
    cleanupProfileState,
    effects,
  })).rejects.toThrow("未完成的任务交接");
  expect(persist).not.toHaveBeenCalled();
  expect(cleanupProfileState).not.toHaveBeenCalled();
  expect(effects.markProfileStateRemoval).not.toHaveBeenCalled();
});

it("rejects binding a second workspace receipt to the same task key", async () => {
  const sharedTaskPath = `${serverWorkspacePath}/.worktrees/shared-task`;
  fixture.worktreeResultPath = sharedTaskPath;
  const firstReceipt = await prepareReceipt("main");
  const firstHandoff = await reserve(firstReceipt, "same original task");
  await expect(acknowledgeWorkspaceOperationV2(firstReceipt.receipt, { profile, server })).resolves.toBe("consumed");

  await expect(prepareReceipt("feature/retry")).rejects.toThrow("原工作区操作仍未确认");
  expect(fixture.rpcCalls.filter(call => call.method === "runtime.worktrees.prepareV2")).toHaveLength(1);

  const secondReceipt = await openWorkspaceWithReceipt(profile, server, sharedTaskPath, false);
  expect(secondReceipt.receipt.id).not.toBe(firstReceipt.receipt.id);
  expect(secondReceipt.path).toBe(firstReceipt.path);
  await expect(reserveWorkspaceTaskHandoff(profile, server, secondReceipt.receipt, {
    cwd: secondReceipt.path,
    prompt: "same original task",
    model: "review-model",
  })).rejects.toThrow("不会绑定其他工作区回执");

  const stillLinked = await loadWorkspaceTaskHandoff(profile, server, { receiptId: firstReceipt.receipt.id });
  expect(stillLinked?.handle).toEqual(firstHandoff);
  expect(await loadWorkspaceTaskHandoff(profile, server, { receiptId: secondReceipt.receipt.id })).toBeNull();
  expect([...fixture.asyncValues.keys()].filter(key => key === pendingThreadCreationKey(profile, server, sharedTaskPath))).toHaveLength(1);
  expectNoTaskStartOrTurn();
});

it("tracks the durable phase write but lets a held Gateway reply remain outside the Native profile lock", async () => {
  const receipt = await prepareReceipt();
  const handoff = await reserve(receipt);
  await updateWorkspaceTaskHandoff(handoff, value => ({
    ...value,
    linked: {
      ...value.linked!,
      taskScope: scopeAtTask,
      startParams: {
        cwd: value.linked!.input.cwd,
        clientRequestId: value.clientRequestId,
        model: value.linked!.input.model,
      },
    },
  }));
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  const gatewayReply = deferred<string>();
  const key = handoff.key;
  fixture.setItemOverride = async (requestedKey, value) => {
    if (requestedKey === key) {
      writeStarted.resolve(undefined);
      await releaseWrite.promise;
    }
    fixture.asyncValues.set(requestedKey, value);
  };

  let sendCalled = false;
  let writesDrained = false;
  const operation = startWorkspaceTaskHandoffRpc(handoff, value => ({
    ...value,
    dispatched: true,
    linked: { ...value.linked!, threadPhase: "sent" },
  }), () => {
    sendCalled = true;
    return gatewayReply.promise;
  });
  await writeStarted.promise;
  const waitForWrites = waitForPendingThreadCreationWrites(profile.id).then(() => { writesDrained = true; });
  expect(writesDrained).toBe(false);

  releaseWrite.resolve(undefined);
  const started = await operation;
  await waitForWrites;
  expect(sendCalled).toBe(true);
  expect(writesDrained).toBe(true);
  let replySettled = false;
  void started.response.then(() => { replySettled = true; });
  expect(replySettled).toBe(false);
  gatewayReply.resolve("ready reply");
  await expect(started.response).resolves.toBe("ready reply");
});
