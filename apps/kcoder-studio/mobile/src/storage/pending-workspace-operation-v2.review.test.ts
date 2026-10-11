import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";

const fixture = vi.hoisted(() => ({
  asyncValues: new Map<string, string>(),
  secureValues: new Map<string, string>(),
  profilesByRpcToken: new Map<string, string>(),
  scopesByProfile: new Map<string, { version: 2; rootId: string; scopeId: string; familyId: string }>(),
  scopeRequests: [] as Array<{ profileId: string; rootId: string; scopeId: string; familyId: string }>,
  readRequests: [] as Array<{ profileId: string; id: string; scopeId: string }>,
  mutationRequests: [] as Array<{ profileId: string; method: string; params: Record<string, unknown> }>,
  remoteReceipts: new Map<string, { scope: { version: 2; rootId: string; scopeId: string; familyId: string }; receipt: Record<string, unknown> }>(),
  mutationMode: "ready" as "ready" | "unknown-first" | "capacity",
  heldMethods: new Set<string>(),
  heldReplies: [] as Array<{ profileId: string; method: string; deliver(): void }>,
  storageReads: [] as string[],
  sockets: [] as Array<{ close(): void }>,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getAllKeys: async () => [...fixture.asyncValues.keys()],
  getItem: async (key: string) => { fixture.storageReads.push(key); return fixture.asyncValues.get(key) ?? null; },
  setItem: async (key: string, value: string) => { fixture.asyncValues.set(key, value); },
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

import { WORKSPACE_SCOPE_V2, workspaceParamsDigestV2 } from "@/protocol/workspace-operation-receipts-v2";
import { openWorkspaceWithReceipt, prepareManagedWorktreeWithReceipt } from "@/runtime/task-runtime/workspaces";
import { loadProfiles, persistProfiles } from "./profile-store";
import { withLocalIdentityLock } from "./context-lock";
import { captureWorkspaceProfileIdentity, withWorkspaceProfileWrite } from "./workspace-profile-fence";
import { ProfileCoordinator } from "@/state/profile-coordinator";
import { removeGatewayProfile } from "@/state/remove-gateway-profile";
import {
  acknowledgeConfirmedWorkspaceOperation,
  loadConfirmedWorkspaceOperationReceipt,
  pendingWorkspaceOperationPrefix,
} from "./pending-workspace-operation";
import { pendingWorkspaceOperationPrefixV2 } from "./pending-workspace-operation-v2";
import { pendingThreadCreationKey } from "./pending-thread-creation";

type RpcRequest = { id?: number; method?: string; params?: Record<string, unknown> };
type Scope = { version: 2; rootId: string; scopeId: string; familyId: string };

class ReceiptGatewaySocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly profileId: string;

  constructor(url: string) {
    const token = new URL(url).searchParams.get("token") ?? "";
    this.profileId = fixture.profilesByRpcToken.get(token) ?? "unmapped-profile";
    fixture.sockets.push(this);
    queueMicrotask(() => {
      this.readyState = ReceiptGatewaySocket.OPEN;
      this.onopen?.();
    });
  }

  send(raw: string): void {
    const request = JSON.parse(raw) as RpcRequest;
    if (!request.method || typeof request.id !== "number") return;
    if (request.method === "initialize") {
      this.reply(request.id, { protocolVersion: "2026-07-27", capabilities: { experimental: { workspaceOperationReceiptsV2: true } } }, request.method);
      return;
    }
    if (request.method === "runtime.workspaces.operation/scopeV2") {
      const scope = fixture.scopesByProfile.get(this.profileId)!;
      fixture.scopeRequests.push({ profileId: this.profileId, ...scope });
      this.reply(request.id, { ...scope }, request.method);
      return;
    }
    if (request.method === "runtime.workspaces.operation/readV2") {
      const id = String(request.params?.clientRequestId ?? "");
      const current = fixture.scopesByProfile.get(this.profileId)!;
      fixture.readRequests.push({ profileId: this.profileId, id, scopeId: current.scopeId });
      const prior = fixture.remoteReceipts.get(id);
      this.reply(request.id, prior ? { scope: current, receipt: prior.receipt } : { scope: current, receipt: null }, request.method);
      return;
    }
    if (request.method !== "runtime.workspaces.prepareV2" && request.method !== "runtime.workspaces.openV2" && request.method !== "runtime.worktrees.prepareV2") return;

    const params = request.params ?? {};
    const currentScope = fixture.scopesByProfile.get(this.profileId)!;
    const requestScope: Scope = { ...currentScope, scopeId: typeof params.scopeId === "string" ? params.scopeId : currentScope.scopeId };
    const id = String(params.clientRequestId ?? "");
    const method = request.method;
    const workspacePath = request.method === "runtime.worktrees.prepareV2"
      ? `${String(params.sourcePath ?? "/workspace/review")}/.worktrees/${String(params.worktreeId ?? "review")}`
      : String(params.workspacePath ?? "/workspace/review");
    const paramsDigest = workspaceParamsDigestV2(method, params);
    const call = { profileId: this.profileId, method, params: { ...params } };
    fixture.mutationRequests.push(call);
    if (fixture.mutationMode === "capacity") {
      this.replyError(request.id, -32032, "workspace receipt capacity reached", { kind: "workspaceOperationCapacity" }, request.method);
      return;
    }
    const isFirstMutation = fixture.mutationRequests.length === 1;
    const status = fixture.mutationMode === "unknown-first" && isFirstMutation ? "unknown" : "ready";
    const receipt = {
      clientRequestId: id,
      method,
      paramsDigest,
      status,
      workspacePath: status === "ready" ? workspacePath : null,
    };
    const remote = { scope: requestScope, receipt };
    fixture.remoteReceipts.set(id, remote);

    if (fixture.mutationMode === "unknown-first" && isFirstMutation) {
      this.replyError(request.id, -32000, "synthetic acknowledgement loss", { kind: "gatewayRequestExpired", outcome: "unknown" }, request.method);
      return;
    }
    const result = method === "runtime.workspaces.prepareV2"
      ? { mapping: { workspacePath } }
      : method === "runtime.worktrees.prepareV2"
        ? { success: true, path: workspacePath }
        : { workspacePath };
    this.reply(request.id, { scope: requestScope, receipt, result }, request.method);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  private reply(id: number, result: unknown, method: string): void {
    const deliver = () => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
    if (fixture.heldMethods.has(method)) fixture.heldReplies.push({ profileId: this.profileId, method, deliver });
    else queueMicrotask(deliver);
  }

  private replyError(id: number, code: number, message: string, data: unknown, method: string): void {
    const deliver = () => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } }) });
    if (fixture.heldMethods.has(method)) fixture.heldReplies.push({ profileId: this.profileId, method, deliver });
    else queueMicrotask(deliver);
  }
}

function makeProfile(id: string, baseUrl: string, token: string): GatewayProfile {
  return {
    id,
    label: id,
    baseUrl,
    accessToken: `access-${token}`,
    rpcToken: `rpc-${token}`,
    expiresAt: Date.now() + 60_000,
    authorizationGeneration: "device-generation-stable",
    deviceId: "device-stable",
    authMode: "device",
  };
}

const server: KCoderServer = {
  id: "target-stable",
  label: "review target",
  description: "controlled app-server scope fixture",
  runtime: "kcoder",
  transport: "local",
  workspacePath: "/workspace/root",
  command: "kcoder",
  accountIdentity: { principalId: "principal-stable", username: "review", role: "member" },
};

const rootSameGateway = "a".repeat(64);
const rootOtherGateway = "f".repeat(64);
const scopeSameAccount = "b".repeat(64);
const scopeNewAccountGeneration = "c".repeat(64);
const familySameGateway = "d".repeat(64);
const familyOtherGateway = "e".repeat(64);

function scope(rootId: string, scopeId: string, familyId = familySameGateway): Scope {
  return { version: 2, rootId, scopeId, familyId };
}

function releaseHeld(method: string): void {
  fixture.heldMethods.delete(method);
  const released = fixture.heldReplies.filter(reply => reply.method === method);
  fixture.heldReplies = fixture.heldReplies.filter(reply => reply.method !== method);
  for (const reply of released) queueMicrotask(reply.deliver);
}

function releaseAllHeld(): void {
  for (const method of [...fixture.heldMethods]) releaseHeld(method);
  const leftovers = fixture.heldReplies.splice(0);
  for (const reply of leftovers) queueMicrotask(reply.deliver);
}

function resetFixture(): void {
  fixture.asyncValues.clear();
  fixture.secureValues.clear();
  fixture.profilesByRpcToken.clear();
  fixture.scopesByProfile.clear();
  fixture.scopeRequests.length = 0;
  fixture.readRequests.length = 0;
  fixture.mutationRequests.length = 0;
  fixture.storageReads.length = 0;
  fixture.remoteReceipts.clear();
  fixture.mutationMode = "ready";
  fixture.heldMethods.clear();
  fixture.heldReplies.length = 0;
  fixture.sockets.length = 0;
}

async function seedProfiles(profiles: GatewayProfile[]): Promise<void> {
  await persistProfiles(profiles, profiles[0]?.id ?? null);
  for (const profile of profiles) fixture.profilesByRpcToken.set(profile.rpcToken, profile.id);
}

type StoredV2Phase = { id: string; method: string; dispatched: boolean; result?: string };
type StoredV2Operation = {
  id: string;
  kind: string;
  path: string;
  result?: string;
  consumed?: boolean;
  scope: Scope;
  phases: StoredV2Phase[];
};

function storedV2Record(profileId: string): { key: string; raw: string; value: StoredV2Operation } | null {
  const prefix = pendingWorkspaceOperationPrefixV2(profileId);
  for (const [key, raw] of fixture.asyncValues) {
    if (key.startsWith(prefix)) return { key, raw, value: JSON.parse(raw) as StoredV2Operation };
  }
  return null;
}

async function outcome<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

afterEach(() => {
  releaseAllHeld();
  for (const socket of fixture.sockets) socket.close();
  resetFixture();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("V2 workspace operation scope review through the production Gateway client", () => {
  it("does not mint a second mutation through a profile/URL alias for either V2 or legacy V1 Unknown", async () => {
    vi.stubGlobal("WebSocket", ReceiptGatewaySocket as unknown as typeof WebSocket);
    const profileA = makeProfile("alias-review-a", "https://gateway.example.invalid/g/mobile", "alias-a");
    const profileB = makeProfile("alias-review-b", "https://gateway-alias.example.invalid/g/mobile", "alias-b");
    await seedProfiles([profileA, profileB]);
    fixture.scopesByProfile.set(profileA.id, scope(rootSameGateway, scopeSameAccount));
    fixture.scopesByProfile.set(profileB.id, scope(rootSameGateway, scopeSameAccount));
    fixture.mutationMode = "unknown-first";

    const v2Path = "/workspace/shared-create";
    const firstV2 = await outcome(openWorkspaceWithReceipt(profileA, server, v2Path, true));
    const oldV2 = storedV2Record(profileA.id);
    const oldV2Bytes = oldV2?.raw;
    const v2Alias = await outcome(openWorkspaceWithReceipt(profileB, server, v2Path, true));
    const v2MutationCountAfterAlias = fixture.mutationRequests.length;

    const v1Path = "/workspace/legacy-create";
    const legacyKey = pendingWorkspaceOperationPrefix(profileA.id) + encodeURIComponent(JSON.stringify([
      "create",
      pendingThreadCreationKey(profileA, server, v1Path),
    ]));
    const oldV1Bytes = JSON.stringify({
      id: "legacy-alias-unknown-id",
      intent: JSON.stringify([v1Path, "create"]),
      dispatched: true,
    });
    fixture.asyncValues.set(legacyKey, oldV1Bytes);
    const v1Alias = await outcome(openWorkspaceWithReceipt(profileB, server, v1Path, true));
    const v1MutationCountAfterAlias = fixture.mutationRequests.length;

    expect(firstV2.ok).toBe(false);
    expect(oldV2?.value).toMatchObject({ id: expect.any(String), kind: "create", path: v2Path });
    expect(oldV2?.value.result).toBeUndefined();
    expect(v2Alias.ok).toBe(false);
    expect(v2MutationCountAfterAlias).toBe(1);
    expect(oldV2 ? fixture.asyncValues.get(oldV2.key) : undefined).toBe(oldV2Bytes);
    expect(v1Alias.ok).toBe(false);
    expect(v1MutationCountAfterAlias).toBe(1);
    expect(fixture.asyncValues.get(legacyKey)).toBe(oldV1Bytes);
  });

  const sameFamilyScopeDrifts: Array<{
    name: string;
    updateProfile(profile: GatewayProfile): GatewayProfile;
    updateServer(server: KCoderServer): KCoderServer;
    updateScope(scope: Scope): Scope;
  }> = [
    { name: "root identity", updateProfile: profile => profile, updateServer: server => server, updateScope: current => scope(rootOtherGateway, current.scopeId, current.familyId) },
    { name: "device identity", updateProfile: profile => ({ ...profile, deviceId: "device-after-repair" }), updateServer: server => server, updateScope: current => current },
    { name: "authorization generation", updateProfile: profile => ({ ...profile, authorizationGeneration: "generation-after-repair", rpcToken: "rpc-after-repair", accessToken: "access-after-repair" }), updateServer: server => server, updateScope: current => current },
    { name: "account generation", updateProfile: profile => profile, updateServer: server => server, updateScope: current => scope(current.rootId, scopeNewAccountGeneration, current.familyId) },
    { name: "account principal", updateProfile: profile => profile, updateServer: server => ({ ...server, accountIdentity: { ...server.accountIdentity!, principalId: "principal-after-login" } }), updateScope: current => scope(current.rootId, scopeNewAccountGeneration, current.familyId) },
    { name: "account role", updateProfile: profile => profile, updateServer: server => ({ ...server, accountIdentity: { ...server.accountIdentity!, role: "admin" } }), updateScope: current => scope(current.rootId, scopeNewAccountGeneration, current.familyId) },
  ];

  it.each(sameFamilyScopeDrifts)("same-family $name changes keep the original Unknown ID and never mint a replacement", async drift => {
    vi.stubGlobal("WebSocket", ReceiptGatewaySocket as unknown as typeof WebSocket);
    const profile = makeProfile("same-family-drift", "https://same-family.example.invalid/g/mobile", "same-family-a");
    await seedProfiles([profile]);
    const originalScope = scope(rootSameGateway, scopeSameAccount);
    fixture.scopesByProfile.set(profile.id, originalScope);
    fixture.mutationMode = "unknown-first";
    const path = "/workspace/same-family-drift";

    const first = await outcome(openWorkspaceWithReceipt(profile, server, path, true));
    const original = storedV2Record(profile.id);
    expect(first.ok).toBe(false);
    expect(original?.value.phases[0]).toMatchObject({ id: expect.any(String), dispatched: true });
    expect(original?.value.result).toBeUndefined();
    const originalBytes = original?.raw;
    const nextProfile = drift.updateProfile(profile);
    const nextServer = drift.updateServer(server);
    if (nextProfile !== profile) await seedProfiles([nextProfile]);
    fixture.scopesByProfile.set(profile.id, drift.updateScope(originalScope));

    const retried = await outcome(openWorkspaceWithReceipt(nextProfile, nextServer, path, true));
    const after = storedV2Record(profile.id);
    expect(retried.ok).toBe(false);
    expect(fixture.mutationRequests).toHaveLength(1);
    expect(fixture.mutationRequests[0]?.params.clientRequestId).toBe(original?.value.id);
    expect(after?.raw).toBe(originalBytes);
    expect(after?.value.id).toBe(original?.value.id);
    expect(after?.value.result).toBeUndefined();
  });

  it("allows a different verified Gateway family to own an independent same-path operation", async () => {
    vi.stubGlobal("WebSocket", ReceiptGatewaySocket as unknown as typeof WebSocket);
    const profileA = makeProfile("family-independent-a", "https://family-a.example.invalid/g/mobile", "family-a");
    const profileB = makeProfile("family-independent-b", "https://family-b.example.invalid/g/mobile", "family-b");
    await seedProfiles([profileA, profileB]);
    fixture.scopesByProfile.set(profileA.id, scope(rootSameGateway, scopeSameAccount, familySameGateway));
    fixture.scopesByProfile.set(profileB.id, scope(rootSameGateway, scopeSameAccount, familyOtherGateway));
    fixture.mutationMode = "unknown-first";
    const path = "/workspace/independent-family";

    const first = await outcome(openWorkspaceWithReceipt(profileA, server, path, true));
    const original = storedV2Record(profileA.id);
    const originalBytes = original?.raw;
    const independent = await outcome(openWorkspaceWithReceipt(profileB, server, path, true));
    const second = storedV2Record(profileB.id);

    expect(first.ok).toBe(false);
    expect(independent.ok).toBe(true);
    expect(fixture.mutationRequests).toHaveLength(2);
    expect(fixture.mutationRequests[0]?.params.clientRequestId).toBe(original?.value.id);
    expect(fixture.mutationRequests[1]?.params.clientRequestId).not.toBe(original?.value.id);
    expect(original ? fixture.asyncValues.get(original.key) : undefined).toBe(originalBytes);
    expect(second?.value.scope).toMatchObject({ familyId: familyOtherGateway });
  });

  it.each(["unknown", "null"] as const)("keeps a dispatched %s readback on the same ID without reminting", async readback => {
    vi.stubGlobal("WebSocket", ReceiptGatewaySocket as unknown as typeof WebSocket);
    const profile = makeProfile(`readback-${readback}`, `https://readback-${readback}.example.invalid/g/mobile`, `readback-${readback}`);
    await seedProfiles([profile]);
    fixture.scopesByProfile.set(profile.id, scope(rootSameGateway, scopeSameAccount));
    fixture.mutationMode = "unknown-first";
    const path = `/workspace/readback-${readback}`;

    const first = await outcome(openWorkspaceWithReceipt(profile, server, path, true));
    const original = storedV2Record(profile.id);
    expect(first.ok).toBe(false);
    expect(original?.value.phases[0]).toMatchObject({ dispatched: true });
    const id = String(original?.value.id ?? "");
    const originalBytes = original?.raw;
    if (readback === "null") fixture.remoteReceipts.delete(id);

    const retry = await outcome(openWorkspaceWithReceipt(profile, server, path, true));
    const after = storedV2Record(profile.id);
    expect(retry.ok).toBe(false);
    expect(fixture.readRequests).toHaveLength(2);
    expect(fixture.readRequests.map(request => request.id)).toEqual([id, id]);
    expect(fixture.mutationRequests).toHaveLength(1);
    expect(after?.raw).toBe(originalBytes);
  });

  it("does not retry or readback automatically after the remote receipt-capacity response", async () => {
    vi.stubGlobal("WebSocket", ReceiptGatewaySocket as unknown as typeof WebSocket);
    const profile = makeProfile("capacity-review", "https://capacity.example.invalid/g/mobile", "capacity");
    await seedProfiles([profile]);
    fixture.scopesByProfile.set(profile.id, scope(rootSameGateway, scopeSameAccount));
    fixture.mutationMode = "capacity";

    const result = await outcome(openWorkspaceWithReceipt(profile, server, "/workspace/capacity", true));
    const record = storedV2Record(profile.id);

    expect(result.ok).toBe(false);
    expect(String(result.ok ? "" : result.error)).toContain("回执容量已满");
    expect(fixture.mutationRequests).toHaveLength(1);
    expect(fixture.readRequests).toHaveLength(0);
    expect(record?.value.phases[0]).toMatchObject({ dispatched: true });
  });

  it("does not start worktree preparation while the source-open receipt remains Unknown", async () => {
    vi.stubGlobal("WebSocket", ReceiptGatewaySocket as unknown as typeof WebSocket);
    const profile = makeProfile("worktree-source-review", "https://worktree-source.example.invalid/g/mobile", "worktree-source");
    await seedProfiles([profile]);
    fixture.scopesByProfile.set(profile.id, scope(rootSameGateway, scopeSameAccount));
    fixture.mutationMode = "unknown-first";
    const sourcePath = "/workspace/worktree-source";

    const result = await outcome(prepareManagedWorktreeWithReceipt(profile, server, sourcePath, "feature/review"));
    const record = storedV2Record(profile.id);

    expect(result.ok).toBe(false);
    expect(fixture.mutationRequests.map(request => request.method)).toEqual(["runtime.workspaces.openV2"]);
    expect(fixture.readRequests).toHaveLength(1);
    expect(record?.value.kind).toBe("worktree");
    expect(record?.value.phases[0]).toMatchObject({ id: `${record?.value.id}:source`, method: "runtime.workspaces.openV2", dispatched: true });
    expect(record?.value.phases[1]).toMatchObject({ id: record?.value.id, method: "runtime.worktrees.prepareV2", dispatched: false });
  });

  it("does not publish a late A mutation result after fresh scope changes to B", async () => {
    vi.stubGlobal("WebSocket", ReceiptGatewaySocket as unknown as typeof WebSocket);
    const profile = makeProfile("late-scope-review", "https://late-scope.example.invalid/g/mobile", "late-scope");
    await seedProfiles([profile]);
    fixture.scopesByProfile.set(profile.id, scope(rootSameGateway, scopeSameAccount));
    fixture.heldMethods.add("runtime.workspaces.prepareV2");
    const operation = outcome(openWorkspaceWithReceipt(profile, server, "/workspace/late-scope", true));

    await vi.waitFor(() => expect(fixture.mutationRequests).toHaveLength(1));
    const before = storedV2Record(profile.id);
    const beforeBytes = before?.raw;
    expect(before?.value.phases[0]).toMatchObject({ dispatched: true });
    fixture.scopesByProfile.set(profile.id, scope(rootSameGateway, scopeNewAccountGeneration));
    releaseHeld("runtime.workspaces.prepareV2");

    const result = await operation;
    const after = storedV2Record(profile.id);
    expect(result.ok).toBe(false);
    expect(fixture.scopeRequests.at(-1)?.scopeId).toBe(scopeNewAccountGeneration);
    expect(fixture.mutationRequests).toHaveLength(1);
    expect(after?.raw).toBe(beforeBytes);
    expect(after?.value.result).toBeUndefined();
    expect(after?.value.phases[0]?.result).toBeUndefined();
  });

  it("does not load or consume an A ready receipt after only the remote account scopeId changes to B", async () => {
    vi.stubGlobal("WebSocket", ReceiptGatewaySocket as unknown as typeof WebSocket);
    const profile = makeProfile("scope-ready-review", "https://scope-ready.example.invalid/g/mobile", "scope-ready");
    await seedProfiles([profile]);
    fixture.scopesByProfile.set(profile.id, scope(rootSameGateway, scopeSameAccount));

    const path = "/workspace/completed-account-a";
    const completed = await openWorkspaceWithReceipt(profile, server, path, true);
    const record = storedV2Record(profile.id);
    expect(completed.receipt.scope?.scopeId).toBe(scopeSameAccount);
    expect(record?.value.result).toBe(path);
    expect(record?.value.consumed).not.toBe(true);
    const bytesBeforeB = record?.raw;

    // Profile ID, endpoint, device generation, target, principal and role stay
    // fixed. Only the remote authenticated account scope advances from A to B.
    fixture.scopesByProfile.set(profile.id, scope(rootSameGateway, scopeNewAccountGeneration));
    const locator = {
      version: 2 as const,
      receiptId: completed.receipt.id,
      kind: "create" as const,
      sourcePath: path,
    };
    const loaded = await loadConfirmedWorkspaceOperationReceipt(profile, server, locator, completed.path);
    const ack = await acknowledgeConfirmedWorkspaceOperation(completed.receipt, { profile, server });
    const after = storedV2Record(profile.id);

    expect(loaded).toBeNull();
    expect(ack).toBe("unverified");
    expect(after?.raw).toBe(bytesBeforeB);
    expect(after?.value.id).toBe(completed.receipt.id);
    expect(after?.value.result).toBe(path);
    expect(after?.value.consumed).not.toBe(true);
    expect(fixture.scopeRequests.some(item => item.scopeId === scopeNewAccountGeneration)).toBe(true);
    expect(fixture.mutationRequests).toHaveLength(1);
  });

  it("keeps the real Native profile-index gate available while ACK waits on remote scope", async () => {
    vi.stubGlobal("WebSocket", ReceiptGatewaySocket as unknown as typeof WebSocket);
    const profile = makeProfile("held-scope-review", "https://held-scope.example.invalid/g/mobile", "held-scope");
    await seedProfiles([profile]);
    fixture.scopesByProfile.set(profile.id, scope(rootSameGateway, scopeSameAccount));
    const completed = await openWorkspaceWithReceipt(profile, server, "/workspace/held-scope", true);
    fixture.heldMethods.add(WORKSPACE_SCOPE_V2);
    const previousScopeRequests = fixture.scopeRequests.length;
    const ack = acknowledgeConfirmedWorkspaceOperation(completed.receipt, { profile, server });
    try {
      await vi.waitFor(() => expect(fixture.scopeRequests.length).toBeGreaterThan(previousScopeRequests));
      let localWriteEntered = false;
      await withWorkspaceProfileWrite(captureWorkspaceProfileIdentity(profile), async () => { localWriteEntered = true; });
      expect(localWriteEntered).toBe(true);
      releaseHeld(WORKSPACE_SCOPE_V2);
      expect(await ack).toBe("consumed");
      expect(storedV2Record(profile.id)?.value.consumed).toBe(true);
    } finally {
      releaseHeld(WORKSPACE_SCOPE_V2);
      await ack.catch(() => undefined);
    }
    // This is the production Native same-JS-realm lock, not a cross-tab/Web Locks proof.
  });

  it("uses ProfileCoordinator removal guard to refuse an Unknown workspace operation", async () => {
    vi.stubGlobal("WebSocket", ReceiptGatewaySocket as unknown as typeof WebSocket);
    const profile = { ...makeProfile("remove-unknown-review", "https://remove-unknown.example.invalid/g/mobile", "remove-unknown"), authMode: "legacy" as const };
    await seedProfiles([profile]);
    fixture.scopesByProfile.set(profile.id, scope(rootSameGateway, scopeSameAccount));
    fixture.mutationMode = "unknown-first";
    const operation = await outcome(openWorkspaceWithReceipt(profile, server, "/workspace/remove-unknown", true));
    const unknownRecord = storedV2Record(profile.id);
    expect(operation.ok).toBe(false);
    expect(unknownRecord?.value.result).toBeUndefined();
    const snapshot = await loadProfiles();
    const coordinator = new ProfileCoordinator({
      reload: () => loadProfiles(),
      serialize: run => withLocalIdentityLock("gateway-profile-index", run),
    });
    coordinator.hydrate(snapshot);
    const persistCalls: Array<{ profiles: GatewayProfile[]; activeId: string | null }> = [];
    const cleanupProfileState = vi.fn(async () => {});
    const effects = {
      setProfiles: vi.fn(),
      setActiveId: vi.fn(),
      removeProfileRuntimes: vi.fn(),
      clearRuntime: vi.fn(),
      markProfileStateRemoval: vi.fn(() => 1),
    };

    const removal = await outcome(removeGatewayProfile(profile.id, {
      coordinator,
      persist: async (profiles, activeId) => { persistCalls.push({ profiles, activeId }); await persistProfiles(profiles, activeId); },
      cleanupProfileState,
      effects,
    }));

    expect(removal.ok).toBe(false);
    expect(String(removal.ok ? "" : removal.error)).toContain("仍有未确认的工作区操作");
    expect(persistCalls).toHaveLength(0);
    expect(cleanupProfileState).not.toHaveBeenCalled();
    expect(effects.markProfileStateRemoval).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().profiles.map(item => item.id)).toContain(profile.id);
    expect(storedV2Record(profile.id)?.raw).toBe(unknownRecord?.raw);
  });

  it("allows a fresh explicit operation only after the previous ready receipt was consumed", async () => {
    vi.stubGlobal("WebSocket", ReceiptGatewaySocket as unknown as typeof WebSocket);
    const profile = makeProfile("consumed-intent-review", "https://consumed-intent.example.invalid/g/mobile", "consumed-intent");
    await seedProfiles([profile]);
    fixture.scopesByProfile.set(profile.id, scope(rootSameGateway, scopeSameAccount));
    const path = "/workspace/explicit-again";

    const first = await openWorkspaceWithReceipt(profile, server, path, true);
    expect(await acknowledgeConfirmedWorkspaceOperation(first.receipt, { profile, server })).toBe("consumed");
    const oldRecord = storedV2Record(profile.id);
    expect(oldRecord?.value.consumed).toBe(true);
    const second = await openWorkspaceWithReceipt(profile, server, path, true);
    const records = [...fixture.asyncValues.entries()]
      .filter(([key]) => key.startsWith(pendingWorkspaceOperationPrefixV2(profile.id)))
      .map(([, raw]) => JSON.parse(raw) as Record<string, unknown>);

    expect(second.receipt.id).not.toBe(first.receipt.id);
    expect(fixture.mutationRequests).toHaveLength(2);
    expect(records).toHaveLength(2);
    expect(records.some(value => value.id === first.receipt.id && value.consumed === true)).toBe(true);
    expect(records.some(value => value.id === second.receipt.id && value.result === path)).toBe(true);
  });
});
