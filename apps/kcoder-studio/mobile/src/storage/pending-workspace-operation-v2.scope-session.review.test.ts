import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";

const fixture = vi.hoisted(() => ({
  asyncValues: new Map<string, string>(),
  secureValues: new Map<string, string>(),
  clients: [] as Array<ReviewRpcClient>,
  calls: [] as RpcCall[],
  workspaceReceipts: new Map<string, { scope: Scope; receipt: Record<string, unknown> }>(),
  threads: new Map<string, { id: string; cwd: string; title: string; status: string; createdAt: number; updatedAt: number }>(),
  turns: new Map<string, { threadId: string; turnId: string; status: string }>(),
  heldScopes: [] as Array<{ resolve(value: Scope): void }>,
  holdNextScopeCwd: null as string | null,
  dropNextThreadStartAck: false,
  throwCloseNextCwd: null as string | null,
  closeError: null as Error | null,
  capabilityDisabled: false,
  worktreePath: "/workspace/repository/.worktrees/feature-scope-review",
}));

type Scope = { version: 2; rootId: string; scopeId: string; familyId: string };
type RpcCall = { cwd: string; profileId: string; method: string; params: Record<string, unknown> };

vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getAllKeys: async () => [...fixture.asyncValues.keys()],
  getItem: async (key: string) => fixture.asyncValues.get(key) ?? null,
  setItem: async (key: string, value: string) => { fixture.asyncValues.set(key, value); },
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
import { WORKSPACE_READ_V2, WORKSPACE_SCOPE_V2, workspaceParamsDigestV2 } from "@/protocol/workspace-operation-receipts-v2";
import { TaskRuntime } from "@/runtime/task-runtime/core";
import { TaskRuntimeRegistry } from "@/runtime/task-runtime/registry";
import { retryCreationCleanup } from "@/runtime/task-runtime/factories";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime/connectionFactory";
import { acknowledgeWorkspaceOperationV2, confirmWorkspaceTaskRoute, withWorkspaceScopeSession } from "@/storage/pending-workspace-operation-v2";
import { openWorkspaceWithReceipt, prepareManagedWorktreeWithReceipt } from "@/runtime/task-runtime/workspaces";
import { reserveWorkspaceTaskHandoff } from "@/storage/pending-workspace-operation-v2";
import { persistProfiles } from "@/storage/profile-store";
import { WorkspaceProfileFenceError } from "@/storage/workspace-profile-fence";

const SOURCE_CWD = "/workspace/repository";
const TASK_CWD = "/workspace/task";
const SOURCE_SCOPE: Scope = { version: 2, rootId: "1".repeat(64), scopeId: "2".repeat(64), familyId: "3".repeat(64) };
const TASK_SCOPE: Scope = { version: 2, rootId: "4".repeat(64), scopeId: "5".repeat(64), familyId: "3".repeat(64) };
const THREAD_TIME = 1_760_000_000_000;

function scopeFor(cwd: string): Scope {
  return cwd === SOURCE_CWD ? SOURCE_SCOPE : TASK_SCOPE;
}

function receiptKey(profileId: string, requestId: string): string {
  return JSON.stringify([profileId, requestId]);
}

class ReviewRpcClient {
  readonly requests: RpcCall[] = [];
  closeCalls = 0;
  closed = false;

  constructor(readonly profileId: string, readonly cwd: string, private readonly closeError: Error | null) {}

  supportsExperimental(capability: string): boolean {
    if (fixture.capabilityDisabled && capability === "workspaceOperationReceiptsV2") return false;
    return ["workspaceOperationReceiptsV2", "threadCreationReceiptsV1", "turnReceiptsV1"].includes(capability);
  }

  subscribe(_listener: (message: unknown) => void): () => void {
    return () => {};
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const call = { cwd: this.cwd, profileId: this.profileId, method, params: { ...params } };
    this.requests.push(call);
    fixture.calls.push(call);

    if (method === WORKSPACE_SCOPE_V2) {
      if (fixture.holdNextScopeCwd === this.cwd) {
        fixture.holdNextScopeCwd = null;
        return await new Promise<Scope>(resolve => fixture.heldScopes.push({ resolve })) as T;
      }
      return scopeFor(this.cwd) as T;
    }
    if (method === WORKSPACE_READ_V2) {
      const id = String(params.clientRequestId ?? "");
      const current = scopeFor(this.cwd);
      const prior = fixture.workspaceReceipts.get(receiptKey(this.profileId, id));
      return { scope: current, receipt: prior?.receipt ?? null } as T;
    }
    if (
      method === "runtime.workspaces.openV2" ||
      method === "runtime.workspaces.prepareV2" ||
      method === "runtime.worktrees.prepareV2"
    ) {
      const scope = scopeFor(this.cwd);
      const requestScope = { ...scope, ...(typeof params.scopeId === "string" ? { scopeId: params.scopeId } : {}) };
      const id = String(params.clientRequestId ?? "");
      const workspacePath = method === "runtime.worktrees.prepareV2"
        ? fixture.worktreePath
        : String(params.workspacePath ?? SOURCE_CWD);
      const receipt = {
        clientRequestId: id,
        method,
        paramsDigest: workspaceParamsDigestV2(method, params),
        status: "ready",
        workspacePath,
      };
      fixture.workspaceReceipts.set(receiptKey(this.profileId, id), { scope: requestScope, receipt });
      const result = method === "runtime.worktrees.prepareV2"
        ? { success: true, path: workspacePath }
        : method === "runtime.workspaces.prepareV2"
          ? { mapping: { workspacePath } }
          : { workspacePath };
      return { scope: requestScope, receipt, result } as T;
    }
    if (method === "thread/start") {
      const requestId = String(params.clientRequestId ?? "missing-request");
      const thread = {
        id: `thread-${requestId}`,
        cwd: String(params.cwd ?? this.cwd),
        title: "scope session task",
        status: "idle",
        createdAt: THREAD_TIME,
        updatedAt: THREAD_TIME,
      };
      fixture.threads.set(receiptKey(this.profileId, requestId), thread);
      if (fixture.dropNextThreadStartAck) {
        fixture.dropNextThreadStartAck = false;
        throw new Error("thread/start accepted but reply was lost");
      }
      return { thread } as T;
    }
    if (method === "thread/creation/read") {
      const requestId = String(params.clientRequestId ?? "");
      const thread = fixture.threads.get(receiptKey(this.profileId, requestId));
      return { receipt: thread ? { status: "ready", threadId: thread.id, thread } : null } as T;
    }
    if (method === "thread/resume" || method === "thread/read") {
      const threadId = String(params.threadId ?? "missing-thread");
      const thread = {
        id: threadId,
        cwd: String(params.cwd ?? this.cwd),
        title: "scope session task",
        status: "idle",
        createdAt: THREAD_TIME,
        updatedAt: THREAD_TIME,
      };
      return (method === "thread/read" ? { thread, messages: [], hasMoreBefore: false } : { thread }) as T;
    }
    if (method === "runtime.worktrees.conversations.link") return { accepted: true, path: params.path } as T;
    if (method === "turn/start") {
      const clientMessageId = String(params.clientMessageId ?? "missing-message");
      const turn = { threadId: String(params.threadId ?? ""), turnId: `turn-${clientMessageId}`, status: "running" };
      fixture.turns.set(JSON.stringify([turn.threadId, clientMessageId]), turn);
      return { turn: { id: turn.turnId, status: turn.status } } as T;
    }
    if (method === "turn/receipt/read") {
      const key = JSON.stringify([params.threadId, params.clientMessageId]);
      const receipt = fixture.turns.get(key);
      return { receipt: receipt ? { ...receipt, clientMessageId: params.clientMessageId } : null } as T;
    }
    return {} as T;
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
    if (this.closeError) throw this.closeError;
  }
}

function makeProfile(): GatewayProfile {
  return {
    id: "scope-session-review-profile",
    label: "scope session review",
    baseUrl: "https://scope-session.example.invalid/g/mobile",
    accessToken: "private-access-token",
    rpcToken: "private-rpc-token",
    expiresAt: Date.now() + 60_000,
    authorizationGeneration: "scope-session-generation",
    deviceId: "scope-session-device",
    authMode: "legacy",
  };
}

function makeServer(role = "member"): KCoderServer {
  return {
    id: "scope-session-target",
    label: "scope session target",
    description: "test target",
    runtime: "kcoder",
    transport: "local",
    workspacePath: SOURCE_CWD,
    command: "kcoder",
    accountIdentity: { principalId: "scope-session-principal", username: "review", role },
  };
}

function installConnector(): void {
  taskRuntimeTestHelpers.setConnector(async (profile, _server, cwd) => {
    const actualCwd = cwd ?? SOURCE_CWD;
    const closeError = fixture.throwCloseNextCwd === actualCwd ? fixture.closeError : null;
    if (fixture.throwCloseNextCwd === actualCwd) fixture.throwCloseNextCwd = null;
    const client = new ReviewRpcClient(profile.id, actualCwd, closeError);
    fixture.clients.push(client);
    return client as never;
  });
}

async function seedProfile(profile: GatewayProfile): Promise<void> {
  await persistProfiles([profile], profile.id);
}

async function makeHandoff(profile: GatewayProfile, server: KCoderServer, worktree = false): Promise<{
  input: Parameters<typeof TaskRuntime.create>[0];
  handoff: Awaited<ReturnType<typeof reserveWorkspaceTaskHandoff>>;
  receipt: Awaited<ReturnType<typeof openWorkspaceWithReceipt>>["receipt"];
}> {
  const operation = worktree
    ? await prepareManagedWorktreeWithReceipt(profile, server, SOURCE_CWD, "feature/scope-session")
    : await openWorkspaceWithReceipt(profile, server, TASK_CWD, true);
  const taskInput = {
    cwd: operation.path,
    prompt: "continue the scoped task",
    model: "review-model",
    ...(worktree ? { managedWorktreeSourcePath: SOURCE_CWD } : {}),
  };
  const handoff = await reserveWorkspaceTaskHandoff(profile, server, operation.receipt, taskInput);
  return {
    handoff,
    receipt: operation.receipt,
    input: { ...taskInput, profile, server, workspaceHandoff: handoff },
  };
}

function resetWireEvidence(): void {
  fixture.clients.length = 0;
  fixture.calls.length = 0;
  fixture.heldScopes.length = 0;
}

async function settled<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

beforeEach(() => {
  fixture.asyncValues.clear();
  fixture.secureValues.clear();
  fixture.clients.length = 0;
  fixture.calls.length = 0;
  fixture.workspaceReceipts.clear();
  fixture.threads.clear();
  fixture.turns.clear();
  fixture.heldScopes.length = 0;
  fixture.holdNextScopeCwd = null;
  fixture.dropNextThreadStartAck = false;
  fixture.throwCloseNextCwd = null;
  fixture.closeError = null;
  fixture.capabilityDisabled = false;
  fixture.worktreePath = `${SOURCE_CWD}/.worktrees/feature-scope-review`;
  installConnector();
});

afterEach(() => {
  for (const client of fixture.clients) {
    if (!client.closed) {
      try { client.close(); } catch { /* Cleanup after the assertion under test. */ }
    }
  }
  retryCreationCleanup(32);
  taskRuntimeTestHelpers.resetConnector();
  vi.restoreAllMocks();
});

describe("operation-local workspace scope session consumers", () => {
  it("reuses one source connector while preserving each fresh source scope and separate task-root checks", async () => {
    const profile = makeProfile();
    const server = makeServer();
    await seedProfile(profile);
    const { input } = await makeHandoff(profile, server);
    resetWireEvidence();

    const runtime = await TaskRuntime.create(input);
    try {
      const sourceClients = fixture.clients.filter(client => client.cwd === SOURCE_CWD);
      expect(sourceClients).toHaveLength(1);
      const sourceStages = sourceClients[0].requests.map(call => call.method).filter(method => method === WORKSPACE_SCOPE_V2);
      expect(sourceStages).toHaveLength(7);

      const taskClients = fixture.clients.filter(client => client.cwd === TASK_CWD);
      expect(taskClients).toHaveLength(2);
      expect(fixture.calls.filter(call => call.method === WORKSPACE_SCOPE_V2 && call.cwd === TASK_CWD).length).toBe(6);
      const threadStart = fixture.calls.find(call => call.method === "thread/start");
      const turnStart = fixture.calls.find(call => call.method === "turn/start");
      expect(threadStart?.cwd).toBe(TASK_CWD);
      expect(fixture.calls.filter(call => call.method === "thread/creation/read")).toHaveLength(0);
      expect(threadStart?.params.clientRequestId).toBe(input.workspaceHandoff!.clientRequestId);
      expect(turnStart?.cwd).toBe(TASK_CWD);
      expect(turnStart?.params.threadId).toBe(runtime.getSnapshot().threadId);
      expect(turnStart?.params.clientMessageId).toBe(input.workspaceHandoff!.clientRequestId + "-initial-turn");
      expect(fixture.calls.findIndex(call => call.method === "thread/start")).toBeLessThan(fixture.calls.findIndex(call => call.method === "turn/start"));
      expect(fixture.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
      expect(fixture.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
      expect(runtime.getSnapshot().cwd).toBe(TASK_CWD);
      expect(runtime.getSnapshot().activeTurnId).toBe(`turn-${input.workspaceHandoff!.clientRequestId}-initial-turn`);
    } finally {
      runtime.close();
    }
    // The injected connector records transports and RPC ordering only; it does not prove a wire initialize handshake.
  });

  it("keeps the worktree task root separate from the reusable source verifier and registry link", async () => {
    const profile = makeProfile();
    const server = makeServer();
    await seedProfile(profile);
    const { input } = await makeHandoff(profile, server, true);
    const taskPath = input.cwd;
    expect(taskPath).toBe(fixture.worktreePath);
    resetWireEvidence();

    const runtime = await TaskRuntime.create(input);
    try {
      const sourceClients = fixture.clients.filter(client => client.cwd === SOURCE_CWD);
      const sourceVerifier = sourceClients.find(client => client.requests.some(call => call.method === WORKSPACE_SCOPE_V2));
      const registryClient = sourceClients.find(client => client.requests.some(call => call.method === "runtime.worktrees.conversations.link"));
      const taskClients = fixture.clients.filter(client => client.cwd === taskPath);

      expect(sourceVerifier).toBeDefined();
      expect(sourceVerifier?.requests.filter(call => call.method === WORKSPACE_SCOPE_V2).length).toBeGreaterThan(1);
      expect(registryClient).toBeDefined();
      expect(registryClient?.requests.map(call => call.method)).toEqual(["runtime.worktrees.conversations.link"]);
      expect(registryClient?.requests[0]?.params.path).toBe(taskPath);
      expect((registryClient?.requests[0]?.params.conversation as Record<string, unknown>).workspacePath).toBe(taskPath);
      expect(taskClients).toHaveLength(2);
      expect(taskClients.flatMap(client => client.requests).some(call => call.method === "thread/start")).toBe(true);
      expect(taskClients.flatMap(client => client.requests).some(call => call.method === "turn/start")).toBe(true);
      expect(taskClients.flatMap(client => client.requests).filter(call => call.method === WORKSPACE_SCOPE_V2).length).toBeGreaterThan(0);
      expect(scopeFor(SOURCE_CWD).rootId).not.toBe(scopeFor(taskPath).rootId);
      expect(runtime.getSnapshot().cwd).toBe(taskPath);
    } finally {
      runtime.close();
    }
  });

  it("returns one adopted runtime after source close and diagnostic failures without replaying the accepted turn", async () => {
    const profile = makeProfile();
    const server = makeServer();
    await seedProfile(profile);
    const { input } = await makeHandoff(profile, server);
    resetWireEvidence();
    fixture.dropNextThreadStartAck = true;
    fixture.throwCloseNextCwd = SOURCE_CWD;
    fixture.closeError = new Error("private transport diagnostic must not escape");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("diagnostic logger also failed"); });
    const registry = new TaskRuntimeRegistry();
    const first = TaskRuntime.claimCreation(input, registry);
    const second = TaskRuntime.claimCreation({ ...input }, registry);

    try {
      expect(second.result).toBe(first.result);
      const runtime = await first.result;
      expect(await second.result).toBe(runtime);
      expect(first.adopt(registry, profile.id, server.id)).toBe(true);
      expect(runtime.isDisposed()).toBe(false);
      expect(registry.get(profile.id, server.id, runtime.getSnapshot().threadId)).toBe(runtime);
      const returnedClient = runtime.client as unknown as ReviewRpcClient;
      expect(returnedClient.cwd).toBe(TASK_CWD);
      expect(returnedClient.closeCalls).toBe(0);
      expect(fixture.clients.find(client => client.cwd === SOURCE_CWD)?.closeCalls).toBe(1);
      expect(fixture.calls.filter(call => call.method === "thread/start")).toHaveLength(1);
      expect(fixture.calls.filter(call => call.method === "thread/creation/read")).toHaveLength(1);
      expect(fixture.calls.find(call => call.method === "thread/creation/read")?.params.clientRequestId).toBe(input.workspaceHandoff!.clientRequestId);
      expect(fixture.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
      expect(fixture.calls.findIndex(call => call.method === "thread/start")).toBeLessThan(fixture.calls.findIndex(call => call.method === "thread/creation/read"));
      expect(fixture.calls.findIndex(call => call.method === "thread/creation/read")).toBeLessThan(fixture.calls.findIndex(call => call.method === "turn/start"));
      expect(fixture.calls.some(call => call.method === "turn/interrupt")).toBe(false);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith("workspace_scope_cleanup_pending");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private transport diagnostic");
    } finally {
      first.release();
      second.release();
      registry.removeProfile(profile.id);
    }
  });

  it("preserves the exact body sentinel when source close and fixed-code diagnostics both throw", async () => {
    const profile = makeProfile();
    const server = makeServer();
    await seedProfile(profile);
    fixture.throwCloseNextCwd = SOURCE_CWD;
    fixture.closeError = new Error("transport close secret");
    const sentinel = new Error("original operation sentinel");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("logger sentinel"); });

    const result = await settled(withWorkspaceScopeSession(profile, server, async session => session.withScope(async received => {
      expect(received).toEqual(SOURCE_SCOPE);
      throw sentinel;
    })));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(sentinel);
    expect(fixture.clients).toHaveLength(1);
    expect(fixture.clients[0].closeCalls).toBe(1);
    expect(fixture.clients[0].requests.map(call => call.method)).toEqual([WORKSPACE_SCOPE_V2]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("workspace_scope_cleanup_pending");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("transport close secret");
  });

  it("rejects an owner-role drift during a held source reply before task creation or storage publication", async () => {
    const profile = makeProfile();
    const server = makeServer();
    await seedProfile(profile);
    const { input, handoff } = await makeHandoff(profile, server);
    const originalLink = fixture.asyncValues.get(handoff.key);
    resetWireEvidence();
    fixture.holdNextScopeCwd = SOURCE_CWD;

    const attempt = settled(TaskRuntime.create(input));
    await vi.waitFor(() => expect(fixture.heldScopes).toHaveLength(1));
    server.accountIdentity!.role = "admin";
    fixture.heldScopes[0].resolve(SOURCE_SCOPE);
    const result = await attempt;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(WorkspaceProfileFenceError);
    expect(fixture.calls.filter(call => call.method === "thread/start" || call.method === "turn/start")).toHaveLength(0);
    expect(fixture.calls.filter(call => call.method === "runtime.workspaces.prepareV2" || call.method === "runtime.workspaces.openV2")).toHaveLength(0);
    expect(fixture.clients.filter(client => client.cwd === SOURCE_CWD)).toHaveLength(1);
    expect(fixture.clients.filter(client => client.cwd === TASK_CWD)).toHaveLength(0);
    expect(fixture.asyncValues.get(handoff.key)).toBe(originalLink);
  });

  it("keeps the original capability-validation error when opening a session fails and close also throws", async () => {
    const profile = makeProfile();
    const server = makeServer();
    await seedProfile(profile);
    fixture.capabilityDisabled = true;
    fixture.throwCloseNextCwd = SOURCE_CWD;
    fixture.closeError = new Error("close failure detail");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("diagnostic failure"); });
    let bodyCalled = false;

    const result = await settled(withWorkspaceScopeSession(profile, server, async () => { bodyCalled = true; return undefined; }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error)).toContain("目标不支持安全工作区回执");
    expect(bodyCalled).toBe(false);
    expect(fixture.clients).toHaveLength(1);
    expect(fixture.clients[0].closeCalls).toBe(1);
    expect(fixture.clients[0].requests).toHaveLength(0);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("workspace_scope_cleanup_pending");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("close failure detail");
  });

  it("keeps a committed route confirmation successful when only the source session close fails", async () => {
    const profile = makeProfile();
    const server = makeServer();
    await seedProfile(profile);
    const { input, handoff, receipt } = await makeHandoff(profile, server);
    const runtime = await TaskRuntime.create(input);
    await expect(acknowledgeWorkspaceOperationV2(receipt, { profile, server })).resolves.toBe("consumed");
    const threadId = runtime.getSnapshot().threadId;
    const beforeThreadStarts = fixture.calls.filter(call => call.method === "thread/start").length;
    const beforeTurnStarts = fixture.calls.filter(call => call.method === "turn/start").length;
    const beforeWorkspaceMutations = fixture.calls.filter(call => call.method === "runtime.workspaces.openV2" || call.method === "runtime.workspaces.prepareV2" || call.method === "runtime.worktrees.prepareV2").length;
    resetWireEvidence();
    fixture.throwCloseNextCwd = SOURCE_CWD;
    fixture.closeError = new Error("source close failure after route commit");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(confirmWorkspaceTaskRoute(
        profile,
        server,
        handoff,
        threadId,
        () => !runtime.isDisposed() && runtime.getSnapshot().sendAcceptanceUnknown === false,
      )).resolves.toBe(true);

      expect(fixture.clients.find(client => client.cwd === SOURCE_CWD)?.closeCalls).toBe(1);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith("workspace_scope_cleanup_pending");
      expect(fixture.asyncValues.has(handoff.key)).toBe(false);
      expect(fixture.calls.filter(call => call.method === "thread/start")).toHaveLength(0);
      expect(fixture.calls.filter(call => call.method === "turn/start")).toHaveLength(0);
      expect(fixture.calls.filter(call => call.method === "runtime.workspaces.openV2" || call.method === "runtime.workspaces.prepareV2" || call.method === "runtime.worktrees.prepareV2")).toHaveLength(0);
      expect(beforeThreadStarts).toBe(1);
      expect(beforeTurnStarts).toBe(1);
      expect(beforeWorkspaceMutations).toBe(1);
      expect(runtime.isDisposed()).toBe(false);
    } finally {
      runtime.close();
    }
  });


  it("does not connect or write when route readiness is already false", async () => {
    const profile = makeProfile();
    const server = makeServer();
    await seedProfile(profile);
    const { handoff } = await makeHandoff(profile, server);
    const storageBefore = [...fixture.asyncValues.entries()];
    const linkBefore = fixture.asyncValues.get(handoff.key);
    resetWireEvidence();
    const setItem = vi.spyOn(AsyncStorage, "setItem");
    const removeItem = vi.spyOn(AsyncStorage, "removeItem");
    const multiRemove = vi.spyOn(AsyncStorage, "multiRemove");

    await expect(confirmWorkspaceTaskRoute(profile, server, handoff, "not-yet-created", () => false)).resolves.toBe(false);

    expect(fixture.clients).toHaveLength(0);
    expect(fixture.calls).toHaveLength(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(multiRemove).not.toHaveBeenCalled();
    expect(fixture.asyncValues.get(handoff.key)).toBe(linkBefore);
    expect([...fixture.asyncValues.entries()]).toEqual(storageBefore);
  });

  it("returns false and preserves the linked receipt when route readiness changes during a held scope reply", async () => {
    const profile = makeProfile();
    const server = makeServer();
    await seedProfile(profile);
    const { input, handoff, receipt } = await makeHandoff(profile, server);
    const runtime = await TaskRuntime.create(input);
    await expect(acknowledgeWorkspaceOperationV2(receipt, { profile, server })).resolves.toBe("consumed");
    const threadId = runtime.getSnapshot().threadId;
    expect(runtime.getSnapshot().sendAcceptanceUnknown).toBe(false);
    const linkBefore = fixture.asyncValues.get(handoff.key);
    const storageBefore = [...fixture.asyncValues.entries()];
    resetWireEvidence();
    fixture.holdNextScopeCwd = TASK_CWD;
    let current = true;
    const setItem = vi.spyOn(AsyncStorage, "setItem");
    const removeItem = vi.spyOn(AsyncStorage, "removeItem");
    const multiRemove = vi.spyOn(AsyncStorage, "multiRemove");
    const pending = settled(confirmWorkspaceTaskRoute(
      profile,
      server,
      handoff,
      threadId,
      () => current && !runtime.isDisposed() && runtime.getSnapshot().sendAcceptanceUnknown === false,
    ));

    try {
      await vi.waitFor(() => expect(fixture.heldScopes).toHaveLength(1));
      current = false;
      fixture.heldScopes[0].resolve(TASK_SCOPE);
      const result = await pending;

      expect(fixture.calls.some(call => call.method === "thread/start" || call.method === "turn/start" || call.method === "runtime.workspaces.openV2" || call.method === "runtime.workspaces.prepareV2" || call.method === "runtime.worktrees.prepareV2")).toBe(false);
      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      expect(multiRemove).not.toHaveBeenCalled();
      expect(fixture.asyncValues.get(handoff.key)).toBe(linkBefore);
      expect([...fixture.asyncValues.entries()]).toEqual(storageBefore);
      expect(runtime.isDisposed()).toBe(false);
      // Pending contract confirmation: the pre-reuse route confirmer returned false for this same-scope stale predicate.
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(false);
    } finally {
      runtime.close();
    }
  });


  it("rejects a held route confirmation when its persisted profile identity changes", async () => {
    const profile = makeProfile();
    const server = makeServer();
    await seedProfile(profile);
    const { input, handoff, receipt } = await makeHandoff(profile, server);
    const runtime = await TaskRuntime.create(input);
    await expect(acknowledgeWorkspaceOperationV2(receipt, { profile, server })).resolves.toBe("consumed");
    const threadId = runtime.getSnapshot().threadId;
    const linkBefore = fixture.asyncValues.get(handoff.key);
    const storageBefore = [...fixture.asyncValues.entries()];
    resetWireEvidence();
    fixture.holdNextScopeCwd = TASK_CWD;
    let activeProfile = profile;
    const setItem = vi.spyOn(AsyncStorage, "setItem");
    const removeItem = vi.spyOn(AsyncStorage, "removeItem");
    const multiRemove = vi.spyOn(AsyncStorage, "multiRemove");
    const isCurrent = () => activeProfile.authorizationGeneration === profile.authorizationGeneration &&
      activeProfile.deviceId === profile.deviceId &&
      !runtime.isDisposed() && runtime.getSnapshot().sendAcceptanceUnknown === false;
    const pending = settled(confirmWorkspaceTaskRoute(profile, server, handoff, threadId, isCurrent));

    try {
      await vi.waitFor(() => expect(fixture.heldScopes).toHaveLength(1));
      const replacement = {
        ...profile,
        authorizationGeneration: "replacement-authorization-generation",
        deviceId: "replacement-device-id",
      };
      await seedProfile(replacement);
      activeProfile = replacement;
      expect(isCurrent()).toBe(false);
      fixture.heldScopes[0].resolve(TASK_SCOPE);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(WorkspaceProfileFenceError);
      expect(fixture.calls.some(call => call.method === "thread/start" || call.method === "turn/start" || call.method === "runtime.workspaces.openV2" || call.method === "runtime.workspaces.prepareV2" || call.method === "runtime.worktrees.prepareV2")).toBe(false);
      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      expect(multiRemove).not.toHaveBeenCalled();
      expect(fixture.asyncValues.get(handoff.key)).toBe(linkBefore);
      expect([...fixture.asyncValues.entries()]).toEqual(storageBefore);
      expect(runtime.isDisposed()).toBe(false);
    } finally {
      runtime.close();
    }
  });

  it("rejects a held route confirmation when the captured server role changes", async () => {
    const profile = makeProfile();
    const server = makeServer();
    await seedProfile(profile);
    const { input, handoff, receipt } = await makeHandoff(profile, server);
    const runtime = await TaskRuntime.create(input);
    await expect(acknowledgeWorkspaceOperationV2(receipt, { profile, server })).resolves.toBe("consumed");
    const threadId = runtime.getSnapshot().threadId;
    const linkBefore = fixture.asyncValues.get(handoff.key);
    const storageBefore = [...fixture.asyncValues.entries()];
    resetWireEvidence();
    fixture.holdNextScopeCwd = TASK_CWD;
    let current = true;
    const setItem = vi.spyOn(AsyncStorage, "setItem");
    const removeItem = vi.spyOn(AsyncStorage, "removeItem");
    const multiRemove = vi.spyOn(AsyncStorage, "multiRemove");
    const isCurrent = () => current && !runtime.isDisposed() && runtime.getSnapshot().sendAcceptanceUnknown === false;
    const pending = settled(confirmWorkspaceTaskRoute(profile, server, handoff, threadId, isCurrent));

    try {
      await vi.waitFor(() => expect(fixture.heldScopes).toHaveLength(1));
      server.accountIdentity!.role = "admin";
      current = false;
      expect(isCurrent()).toBe(false);
      fixture.heldScopes[0].resolve(TASK_SCOPE);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(WorkspaceProfileFenceError);
      expect(fixture.calls.some(call => call.method === "thread/start" || call.method === "turn/start" || call.method === "runtime.workspaces.openV2" || call.method === "runtime.workspaces.prepareV2" || call.method === "runtime.worktrees.prepareV2")).toBe(false);
      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      expect(multiRemove).not.toHaveBeenCalled();
      expect(fixture.asyncValues.get(handoff.key)).toBe(linkBefore);
      expect([...fixture.asyncValues.entries()]).toEqual(storageBefore);
      expect(runtime.isDisposed()).toBe(false);
    } finally {
      runtime.close();
    }
  });
});
