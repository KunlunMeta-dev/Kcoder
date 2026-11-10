// Controlled storage/transport contracts, not mounted Browser or target-runtime evidence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime/connectionFactory";
import { WORKSPACE_SCOPE_V2, workspaceParamsDigestV2, type WorkspaceScopeV2 } from "@/protocol/workspace-operation-receipts-v2";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { PROFILE_INDEX_KEY } from "./profile-store";
import { captureWorkspaceProfileIdentity, withWorkspaceProfileWrite, WorkspaceProfileFenceError } from "./workspace-profile-fence";
import { loadWorkspaceOpenDelivery, pendingWorkspaceOperationPrefixV2, workspaceOperationOwnerV2 } from "./pending-workspace-operation-v2";

const storage = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => storage.values.get(key) ?? null),
  getAllKeys: vi.fn(async () => [...storage.values.keys()]),
  setItem: vi.fn(async (key: string, value: string) => { storage.values.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { storage.values.delete(key); }),
  multiRemove: vi.fn(async (keys: string[]) => { keys.forEach(key => storage.values.delete(key)); }),
} }));

const INDEX = "kcoder-studio:mobile-workspace-operation:v2-index";
const SOURCE = "/workspace/delivery-review";
const SCOPE: WorkspaceScopeV2 = { version: 2, rootId: "1".repeat(64), scopeId: "2".repeat(64), familyId: "3".repeat(64) };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function profile(): GatewayProfile {
  return { id: "delivery-review", label: "Delivery review", baseUrl: "https://delivery.invalid/g/review", accessToken: "synthetic-access", rpcToken: "synthetic-rpc", expiresAt: Date.now() + 60_000, deviceId: "device-review", authorizationGeneration: "generation-review" };
}
function server(): KCoderServer {
  return { id: "target-review", label: "Target review", description: "Controlled target", runtime: "kcoder", transport: "local", workspacePath: SOURCE, accountIdentity: { principalId: "principal-review", username: "review", role: "member" } };
}

// Exact existing durable shape; the production parser/digest/fence remain real.
function seed(ownerProfile: GatewayProfile, ownerServer: KCoderServer, confirmed = false, id = "mobile-workspace-delivery-review") {
  const owner = workspaceOperationOwnerV2(ownerProfile, ownerServer);
  const family = JSON.stringify([SCOPE.familyId, "open", SOURCE]);
  const key = pendingWorkspaceOperationPrefixV2(ownerProfile.id) + encodeURIComponent(JSON.stringify([owner, SCOPE.rootId, SCOPE.scopeId, "open", SOURCE, id]));
  const params = { workspacePath: SOURCE, label: "delivery-review", scopeId: SCOPE.scopeId, clientRequestId: id };
  const value = { version: 2, profileId: ownerProfile.id, authorization: captureWorkspaceProfileIdentity(ownerProfile), owner, family, scope: { ...SCOPE }, id, key, kind: "open", path: SOURCE, intent: SOURCE,
    phases: [{ id, method: "runtime.workspaces.openV2", params, digest: workspaceParamsDigestV2("runtime.workspaces.openV2", params), dispatched: true, result: SOURCE }],
    result: SOURCE, completedAt: 1_760_000_000_000, consumed: false, taskBindingVersion: 1, deliveryToNew: { confirmed } };
  const rows = JSON.parse(storage.values.get(INDEX) ?? "[]");
  rows.push({ profileId: ownerProfile.id, family, id, key });
  storage.values.set(INDEX, JSON.stringify(rows));
  storage.values.set(key, JSON.stringify(value));
  return { key, value };
}
function editRecord(key: string, edit: (value: ReturnType<typeof seed>["value"]) => void) {
  const value = JSON.parse(storage.values.get(key)!);
  edit(value);
  storage.values.set(key, JSON.stringify(value));
}

describe("workspace-open delivery local empty preflight", () => {
  let currentProfile: GatewayProfile;
  let currentServer: KCoderServer;
  let browser: ReturnType<typeof installBrowserProfileFixture>;
  let scope: WorkspaceScopeV2;
  let capability: boolean;
  let connectHold: ReturnType<typeof deferred<void>> | undefined;
  let scopeHold: ReturnType<typeof deferred<WorkspaceScopeV2>> | undefined;
  const clients: Array<{ closed: boolean; close: ReturnType<typeof vi.fn> }> = [];
  const requests: string[] = [];
  const connect = vi.fn();

  // The optional owner predicate is the proposed call-site contract. Reflect.apply
  // exercises that argument on the current implementation without a business stub.
  const read = (isCurrent?: () => boolean) => Reflect.apply(loadWorkspaceOpenDelivery, undefined,
    [currentProfile, currentServer, "open", SOURCE, ...(isCurrent ? [isCurrent] : [])]) as ReturnType<typeof loadWorkspaceOpenDelivery>;

  beforeEach(() => {
    storage.values.clear(); vi.clearAllMocks();
    vi.mocked(AsyncStorage.getItem).mockReset().mockImplementation(async key => storage.values.get(key) ?? null);
    currentProfile = profile(); currentServer = server();
    browser = installBrowserProfileFixture([currentProfile]);
    scope = { ...SCOPE }; capability = true; connectHold = undefined; scopeHold = undefined;
    clients.length = 0; requests.length = 0;
    connect.mockImplementation(async () => {
      const client = { closed: false, close: vi.fn(() => { client.closed = true; }),
        supportsExperimental: (name: string) => name === "workspaceOperationReceiptsV2" && capability,
        request: vi.fn(async (method: string) => {
          requests.push(method);
          if (method !== WORKSPACE_SCOPE_V2) throw new Error("unexpected mutation/read RPC: " + method);
          return scopeHold ? await scopeHold.promise : { ...scope };
        }) };
      clients.push(client);
      if (connectHold) await connectHold.promise;
      return client;
    });
    taskRuntimeTestHelpers.setConnector(connect);
  });
  afterEach(() => {
    // Every case forbids local mutation, workspace mutation, and thread/turn dispatch.
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
    expect(AsyncStorage.getAllKeys).not.toHaveBeenCalled();
    expect(requests.every(method => method === WORKSPACE_SCOPE_V2)).toBe(true);
    expect(clients.every(client => client.closed)).toBe(true);
    taskRuntimeTestHelpers.resetConnector(); vi.restoreAllMocks();
  });

  it.each([undefined, "[]"])("returns an empty local index without initializing a Gateway (%s)", async raw => {
    expect(Platform.OS).toBe("web");
    if (raw !== undefined) storage.values.set(INDEX, raw);
    await expect(read()).resolves.toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("preserves null for an interim relative path when the index is empty", async () => {
    storage.values.set(INDEX, "[]");
    // The original empty-index loop never evaluates family()/path(). Editing
    // a path must not introduce validation errors through the new fast path.
    await expect(loadWorkspaceOpenDelivery(currentProfile, currentServer, "open", "relative/in-progress")).resolves.toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("does not initialize a Gateway when every exact current-owner record is confirmed", async () => {
    seed(currentProfile, currentServer, true);
    seed(currentProfile, currentServer, true, "mobile-workspace-delivery-second");
    const before = [...storage.values];
    await expect(read()).resolves.toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect([...storage.values]).toEqual(before);
  });

  it.each([
    ["empty", "deleted"], ["empty", "generation"], ["empty", "base-url"],
    ["confirmed", "deleted"], ["confirmed", "generation"], ["confirmed", "base-url"],
  ] as const)("preserves the profile fence for %s records after persisted identity is %s", async (records, replacement) => {
    if (records === "confirmed") seed(currentProfile, currentServer, true);
    else storage.values.set(INDEX, "[]");
    const before = [...storage.values];
    if (replacement === "deleted") browser.localStorage.removeItem(PROFILE_INDEX_KEY);
    else browser.localStorage.setItem(PROFILE_INDEX_KEY, JSON.stringify({ profiles: [{ ...currentProfile,
      ...(replacement === "generation" ? { authorizationGeneration: "replacement-generation" } : { baseUrl: "https://replacement.invalid/g/review" }),
    }] }));
    const error = await read().then(() => undefined, value => value);
    expect(error).toBeInstanceOf(WorkspaceProfileFenceError);
    expect(error.message).toBe(new WorkspaceProfileFenceError().message);
    expect(connect).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect([...storage.values]).toEqual(before);
  });

  it.each(["old-owner", "old-shape"] as const)("still qualifies confirmed=true %s records through the original fresh-scope fallback", async variant => {
    const owner = variant === "old-owner" ? { ...currentProfile, baseUrl: "https://old.invalid" } : currentProfile;
    const pending = seed(owner, currentServer, true);
    if (variant === "old-shape") {
      const value = JSON.parse(storage.values.get(pending.key)!);
      delete value.scope.familyId;
      value.family = JSON.stringify([owner.id, owner.baseUrl, currentServer.id, "open", SOURCE]);
      storage.values.set(pending.key, JSON.stringify(value));
      const rows = JSON.parse(storage.values.get(INDEX)!); rows[0].family = value.family;
      storage.values.set(INDEX, JSON.stringify(rows));
    }
    const before = [...storage.values];
    // The original loader does not qualify receipt ownership for an already
    // confirmed delivery, and skips the old five-field family. Preserve null.
    await expect(read()).resolves.toBeNull();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([WORKSPACE_SCOPE_V2]);
    expect([...storage.values]).toEqual(before);
  });

  it("qualifies a pending delivery with fresh scope and returns the original ID without writes", async () => {
    const pending = seed(currentProfile, currentServer);
    const before = [...storage.values];
    await expect(read()).resolves.toMatchObject({ path: SOURCE, receipt: { id: pending.value.id, key: pending.key, scope: SCOPE } });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([WORKSPACE_SCOPE_V2]);
    expect([...storage.values]).toEqual(before);
  });

  it.each(["no-delivery", "old-owner", "profile-alias", "old-shape", "missing-record", "bad-json", "bad-index", "duplicate"] as const)("preserves the original fresh-scope fallback for %s", async variant => {
    const owner = variant === "profile-alias" ? { ...currentProfile, id: "alias-profile" } : variant === "old-owner" ? { ...currentProfile, baseUrl: "https://old.invalid" } : currentProfile;
    const pending = seed(owner, currentServer);
    if (variant === "no-delivery") editRecord(pending.key, value => { delete (value as Partial<typeof value>).deliveryToNew; });
    if (variant === "old-shape") {
      const value = JSON.parse(storage.values.get(pending.key)!);
      delete value.scope.familyId;
      value.family = JSON.stringify([owner.id, owner.baseUrl, currentServer.id, "open", SOURCE]);
      storage.values.set(pending.key, JSON.stringify(value));
      const rows = JSON.parse(storage.values.get(INDEX)!); rows[0].family = value.family;
      storage.values.set(INDEX, JSON.stringify(rows));
    }
    if (variant === "missing-record") storage.values.delete(pending.key);
    if (variant === "bad-json") storage.values.set(pending.key, "{");
    if (variant === "bad-index") storage.values.set(INDEX, "{");
    if (variant === "duplicate") seed(currentProfile, currentServer, false, "mobile-workspace-delivery-duplicate");
    const before = [...storage.values];
    if (variant === "no-delivery" || variant === "old-shape") await expect(read()).resolves.toBeNull();
    else await expect(read()).rejects.toThrow();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([WORKSPACE_SCOPE_V2]);
    expect([...storage.values]).toEqual(before);
  });

  it("does not treat unsupported capability or mismatched fresh scope as empty", async () => {
    seed(currentProfile, currentServer);
    capability = false;
    await expect(read()).rejects.toThrow("目标不支持安全工作区回执");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([]);
    capability = true; scope = { ...SCOPE, scopeId: "4".repeat(64) };
    await expect(read()).rejects.toThrow("原任务工作区身份尚未核对");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("cannot complete an empty read for an owner disposed while local storage was held", async () => {
    const held = deferred<string | null>();
    vi.mocked(AsyncStorage.getItem).mockImplementationOnce(() => held.promise);
    let current = true;
    const pending = read(() => current);
    const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await vi.waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(INDEX));
    // Disposing this captured owner makes its predicate false during the held read.
    current = false; held.resolve(null);
    const result = await outcome;
    expect(result.error).toBeInstanceOf(WorkspaceProfileFenceError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects an expired owner after a confirmed record read was held", async () => {
    const pendingRecord = seed(currentProfile, currentServer, true);
    const before = [...storage.values];
    const held = deferred<string | null>();
    vi.mocked(AsyncStorage.getItem).mockImplementation(async key => key === pendingRecord.key ? await held.promise : storage.values.get(key) ?? null);
    let current = true;
    const outcome = read(() => current).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await vi.waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(pendingRecord.key));
    current = false;
    held.resolve(storage.values.get(pendingRecord.key)!);
    const result = await outcome;
    expect(result.error).toBeInstanceOf(WorkspaceProfileFenceError);
    expect(connect).not.toHaveBeenCalled();
    expect([...storage.values]).toEqual(before);
  });

  it("closes a held connection after current server-role identity changes", async () => {
    seed(currentProfile, currentServer);
    connectHold = deferred<void>();
    const pending = read();
    const outcome = pending.catch(error => error);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    currentServer.accountIdentity!.role = "replacement-role";
    connectHold.resolve();
    expect(await outcome).toBeInstanceOf(WorkspaceProfileFenceError);
    expect(requests).toEqual([]);
  });

  it("rejects a shared profile generation replacement while fresh scope is held", async () => {
    seed(currentProfile, currentServer);
    const before = [...storage.values];
    scopeHold = deferred<WorkspaceScopeV2>();
    const pending = read();
    const outcome = pending.catch(error => error);
    await vi.waitFor(() => expect(requests).toEqual([WORKSPACE_SCOPE_V2]));
    await withWorkspaceProfileWrite(captureWorkspaceProfileIdentity(currentProfile), async () => {
      browser.localStorage.setItem(PROFILE_INDEX_KEY, JSON.stringify({ profiles: [{ ...currentProfile, authorizationGeneration: "replacement-generation", deviceId: "replacement-device" }] }));
    });
    scopeHold.resolve(SCOPE);
    expect(await outcome).toBeInstanceOf(WorkspaceProfileFenceError);
    expect([...storage.values]).toEqual(before);
  });

  it("rereads local receipt bytes after qualification instead of returning the preflight snapshot", async () => {
    const pendingRecord = seed(currentProfile, currentServer);
    scopeHold = deferred<WorkspaceScopeV2>();
    const pending = read();
    const outcome = pending.catch(error => error);
    await vi.waitFor(() => expect(requests).toEqual([WORKSPACE_SCOPE_V2]));
    storage.values.set(pendingRecord.key, "{");
    scopeHold.resolve(SCOPE);
    expect(await outcome).toBeInstanceOf(Error);
    expect(storage.values.get(pendingRecord.key)).toBe("{");
  });
});
