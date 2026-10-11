// Native storage scheduling contract; cross-tab Web authority is tested separately.
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
// Model-independent exact local receipt bookkeeping; actual storage contract, no remote model.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ values: new Map<string, string>(), secureValues: new Map<string, string>(), consumedFailures: 0 }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: vi.fn(async (key: string) => storage.values.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    if (JSON.parse(value).consumed === true && storage.consumedFailures > 0) { storage.consumedFailures--; throw new Error("local storage unavailable"); }
    storage.values.set(key, value);
  }),
  removeItem: vi.fn(async (key: string) => { storage.values.delete(key); }),
  getAllKeys: vi.fn(async () => [...storage.values.keys()]),
  multiRemove: vi.fn(async (keys: string[]) => { for (const key of keys) storage.values.delete(key); }),
} }));
vi.mock("./secure", () => ({
  getSecureValue: async (key: string) => storage.secureValues.get(key) ?? null,
  setSecureValue: async (key: string, value: string) => { storage.secureValues.set(key, value); },
  deleteSecureValue: async (key: string) => { storage.secureValues.delete(key); },
}));
import { persistProfiles } from "./profile-store";
import { WorkspaceProfileFenceError } from "./workspace-profile-fence";
import { MobileRpcError } from "@/gateway/rpc";
import {
  WORKSPACE_READ_V2,
  WORKSPACE_RECEIPTS_V2,
  WORKSPACE_SCOPE_V2,
  workspaceParamsDigestV2,
} from "@/protocol/workspace-operation-receipts-v2";
import { openWorkspaceWithReceipt } from "@/runtime/task-runtime/workspaces";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime";
import {
  acknowledgeWorkspaceOperationV2,
  loadWorkspaceOperationReceiptV2,
  pendingWorkspaceOperationPrefixV2,
} from "./pending-workspace-operation-v2";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  acknowledgeConfirmedWorkspaceOperation, loadConfirmedWorkspaceOperationReceipt,
  recoverableWorkspaceOperation, recoverableWorkspaceOperationWithReceipt,
} from "./pending-workspace-operation";
import { removeWorkspaceStatesForProfile, workspacePreferencesTestHelpers } from "./workspace-preferences";
import { profileStateRemovalTestHelpers } from "./profile-state-removal";
import { profile, server } from "@/runtime/task-runtime/fixture.test-support";
const WORKSPACE_OPERATION_INDEX_V2 = "kcoder-studio:mobile-workspace-operation:v2-index";
const scopeV2 = {
  version: 2 as const,
  rootId: "a".repeat(64),
  scopeId: "b".repeat(64),
  familyId: "c".repeat(64),
};

function installWorkspaceReceiptClientV2(mode: "ready" | "unknown" = "ready") {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let remoteReceipt: Record<string, unknown> | null = null;
  const client = {
    supportsExperimental: (capability: string) => capability === WORKSPACE_RECEIPTS_V2,
    close: vi.fn(),
    request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === WORKSPACE_SCOPE_V2) return scopeV2;
      if (method === WORKSPACE_READ_V2) return { scope: scopeV2, receipt: remoteReceipt };
      if (method !== "runtime.workspaces.openV2") throw new Error(`unexpected V2 review RPC: ${method}`);
      const receipt = {
        clientRequestId: String(params.clientRequestId),
        method,
        paramsDigest: workspaceParamsDigestV2(method, params),
        status: mode === "unknown" ? "unknown" : "ready",
        workspacePath: mode === "unknown" ? null : String(params.workspacePath),
      };
      remoteReceipt = receipt;
      if (mode === "unknown") throw new MobileRpcError("synthetic response loss", -1, "transport", "unknown");
      return {
        scope: scopeV2,
        receipt,
        result: { workspacePath: String(params.workspacePath) },
      };
    }),
  };
  taskRuntimeTestHelpers.setConnector(vi.fn(async () => client as never) as never);
  return { calls, client };
}

async function openReadyReceipt(path = "/source") {
  const transport = installWorkspaceReceiptClientV2("ready");
  const confirmed = await openWorkspaceWithReceipt(profile, server, path);
  return { ...transport, confirmed };
}

beforeEach(async () => { await persistProfiles([profile], profile.id); });
afterEach(() => { storage.secureValues.clear(); storage.values.clear(); storage.consumedFailures = 0; vi.restoreAllMocks(); taskRuntimeTestHelpers.resetConnector(); profileStateRemovalTestHelpers.reset(); workspacePreferencesTestHelpers.reset(); });
const input = () => ({ profile, server, path: "/source", kind: "worktree" as const, intent: "original", mutate: vi.fn(async () => "/confirmed"), readback: vi.fn(async () => "/confirmed") });
it("two failed V2 ACK attempts retain the exact ready receipt and explicit retry consumes without replay", async () => {
  const { calls, confirmed } = await openReadyReceipt();
  storage.consumedFailures = 2;
  await expect(acknowledgeWorkspaceOperationV2(confirmed.receipt, { profile, server })).resolves.toBe("pending");
  expect(JSON.parse(storage.values.get(confirmed.receipt.key)!)).toMatchObject({ id: confirmed.receipt.id, result: "/source" });
  expect(JSON.parse(storage.values.get(confirmed.receipt.key)!).consumed).not.toBe(true);
  const loaded = await loadWorkspaceOperationReceiptV2(profile, server, { receiptId: confirmed.receipt.id, kind: "open", sourcePath: "/source" }, "/source");
  expect(loaded).toEqual(confirmed.receipt);
  await expect(acknowledgeWorkspaceOperationV2(loaded!, { profile, server })).resolves.toBe("consumed");
  expect(calls.filter(call => call.method === "runtime.workspaces.openV2")).toHaveLength(1);
  expect((await loadWorkspaceOperationReceiptV2(profile, server, { receiptId: confirmed.receipt.id, kind: "open", sourcePath: "/source" }, "/source"))?.consumed).toBe(true);
});
it("receipt lookup rejects wrong ID, result or authorization scope and exact consume never changes a replacement", async () => {
  const confirmed = await recoverableWorkspaceOperationWithReceipt(input());
  const locator = { receiptId: confirmed.receipt.id, kind: "worktree" as const, sourcePath: "/source" };
  expect(await loadConfirmedWorkspaceOperationReceipt(profile, server, { ...locator, receiptId: "later" }, "/confirmed")).toBeNull();
  expect(await loadConfirmedWorkspaceOperationReceipt(profile, server, locator, "/other")).toBeNull();
  await expect(loadConfirmedWorkspaceOperationReceipt({ ...profile, authorizationGeneration: "other" }, server, locator, "/confirmed")).rejects.toBeInstanceOf(WorkspaceProfileFenceError);
  const replacement = { id: "later", intent: "later", dispatched: true, result: "/later", completedAt: confirmed.receipt.completedAt + 1 };
  storage.values.set(confirmed.receipt.key, JSON.stringify(replacement));
  await expect(acknowledgeConfirmedWorkspaceOperation(confirmed.receipt)).resolves.toBe("superseded");
  expect(JSON.parse(storage.values.get(confirmed.receipt.key)!)).toEqual(replacement);
});
it("legacy string and typed callers share one actual operation and the string promise identity stays stable", async () => {
  const operation = input(); let resolve!: () => void;
  const hold = new Promise<void>((done) => { resolve = done; });
  operation.mutate.mockImplementation(async () => { await hold; return "/confirmed"; });
  const first = recoverableWorkspaceOperation(operation);
  const second = recoverableWorkspaceOperation(operation);
  const typed = recoverableWorkspaceOperationWithReceipt(operation);
  expect(second).toBe(first); resolve();
  expect(await first).toBe("/confirmed"); expect((await typed).path).toBe("/confirmed"); expect(operation.mutate).toHaveBeenCalledOnce();
});
it("profile removal waits for an ACK write already in storage before removing the record", async () => {
  const confirmed = await recoverableWorkspaceOperationWithReceipt(input());
  let started!: () => void; let release!: () => void;
  const entered = new Promise<void>((done) => { started = done; });
  const hold = new Promise<void>((done) => { release = done; });
  vi.spyOn(AsyncStorage, "setItem").mockImplementationOnce(async (key, value) => { started(); await hold; storage.values.set(key, value); });
  const ack = acknowledgeConfirmedWorkspaceOperation(confirmed.receipt); await entered;
  let removed = false; const removal = removeWorkspaceStatesForProfile(profile.id).then(() => { removed = true; });
  await Promise.resolve(); await Promise.resolve(); expect(removed).toBe(false);
  release(); await Promise.all([ack, removal]); expect(storage.values.has(confirmed.receipt.key)).toBe(false);
});
it("profile cleanup waits for a held V2 ACK read and removes only after exact consume", async () => {
  const { calls, confirmed } = await openReadyReceipt();
  let started!: () => void; let release!: () => void;
  const entered = new Promise<void>((done) => { started = done; });
  const hold = new Promise<void>((done) => { release = done; });
  let held = false;
  const read = vi.spyOn(AsyncStorage, "getItem").mockImplementation(async (key) => {
    const value = storage.values.get(key) ?? null;
    if (key === confirmed.receipt.key && !held) { held = true; started(); await hold; }
    return value;
  });
  const write = vi.spyOn(AsyncStorage, "setItem");
  const ack = acknowledgeWorkspaceOperationV2(confirmed.receipt, { profile, server });
  await entered;
  let removed = false;
  const removal = removeWorkspaceStatesForProfile(profile.id).then(() => { removed = true; });
  await Promise.resolve(); await Promise.resolve(); expect(removed).toBe(false);
  release();
  await expect(ack).resolves.toBe("consumed");
  await removal;
  expect(read).toHaveBeenCalled();
  expect(write).toHaveBeenCalledWith(confirmed.receipt.key, expect.stringContaining('"consumed":true'));
  expect(storage.values.has(confirmed.receipt.key)).toBe(false);
  expect(calls.filter(call => call.method === "runtime.workspaces.openV2")).toHaveLength(1);
});

it("removal during a dispatched V2 write retains the unknown ID and same-ID retry only reads", async () => {
  const { calls } = installWorkspaceReceiptClientV2("unknown");
  let started!: () => void; let release!: () => void;
  const entered = new Promise<void>((done) => { started = done; });
  const hold = new Promise<void>((done) => { release = done; });
  const write = vi.spyOn(AsyncStorage, "setItem").mockImplementation(async (key, value) => {
    let parsed: { phases?: Array<{ dispatched?: boolean }> } | null = null;
    try { parsed = JSON.parse(value) as { phases?: Array<{ dispatched?: boolean }> }; } catch {}
    if (key.startsWith(pendingWorkspaceOperationPrefixV2(profile.id)) && parsed?.phases?.[0]?.dispatched === true) { started(); await hold; }
    storage.values.set(key, value);
  });
  const opening = openWorkspaceWithReceipt(profile, server, "/source");
  const observed = opening.then(() => null, (error: unknown) => error);
  await entered;
  let removed = false;
  const removal = removeWorkspaceStatesForProfile(profile.id).then(() => { removed = true; });
  await Promise.resolve(); expect(removed).toBe(false);
  release();
  await expect(observed).resolves.toBeInstanceOf(WorkspaceProfileFenceError);
  await expect(removal).rejects.toThrow();
  const rows = JSON.parse(storage.values.get(WORKSPACE_OPERATION_INDEX_V2)!) as Array<{ profileId: string; key: string; id: string }>;
  const reserved = rows.find(row => row.profileId === profile.id);
  expect(reserved).toBeDefined();
  const record = JSON.parse(storage.values.get(reserved!.key)!) as { id: string; result?: string; consumed?: boolean; phases: Array<{ dispatched: boolean }> };
  expect(record).toMatchObject({ id: reserved!.id, phases: [{ dispatched: true }] });
  expect(record.result).toBeUndefined(); expect(record.consumed).not.toBe(true);
  expect(calls.filter(call => call.method === "runtime.workspaces.openV2")).toHaveLength(1);
  expect(write).toHaveBeenCalled();

  profileStateRemovalTestHelpers.reset();
  await expect(openWorkspaceWithReceipt(profile, server, "/source")).rejects.toThrow(/未知/);
  expect(calls.filter(call => call.method === "runtime.workspaces.openV2")).toHaveLength(1);
  expect(calls.filter(call => call.method === WORKSPACE_READ_V2)).toHaveLength(1);
  expect(storage.values.has(reserved!.key)).toBe(true);
});

it("removal during the initial V2 reservation write keeps the charged row and sends no operation RPC", async () => {
  const { calls } = installWorkspaceReceiptClientV2("ready");
  let started!: () => void; let release!: () => void;
  const entered = new Promise<void>((done) => { started = done; });
  const hold = new Promise<void>((done) => { release = done; });
  vi.spyOn(AsyncStorage, "setItem").mockImplementationOnce(async (key, value) => { started(); await hold; storage.values.set(key, value); });
  const opening = openWorkspaceWithReceipt(profile, server, "/source");
  const observed = opening.then(() => null, (error: unknown) => error);
  await entered;
  let removed = false;
  const removal = removeWorkspaceStatesForProfile(profile.id).then(() => { removed = true; });
  await Promise.resolve(); expect(removed).toBe(false);
  release();
  expect(await observed).toBeInstanceOf(WorkspaceProfileFenceError);
  await expect(removal).rejects.toThrow();
  const rows = JSON.parse(storage.values.get(WORKSPACE_OPERATION_INDEX_V2)!) as Array<{ profileId: string; key: string; id: string }>;
  const reserved = rows.find(row => row.profileId === profile.id);
  expect(reserved).toBeDefined();
  const record = JSON.parse(storage.values.get(reserved!.key)!) as { id: string; result?: string; consumed?: boolean; phases: Array<{ dispatched: boolean }> };
  expect(record).toMatchObject({ id: reserved!.id, phases: [{ dispatched: false }] });
  expect(record.result).toBeUndefined(); expect(record.consumed).not.toBe(true);
  expect(calls.map(call => call.method)).toEqual([WORKSPACE_SCOPE_V2]);
  expect(storage.values.has(reserved!.key)).toBe(true);
});
