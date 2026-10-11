import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc, withWorkspaceProfileWrite, WorkspaceProfileFenceError, type WorkspaceProfileIdentity } from "./workspace-profile-fence";
import { withLocalIdentityLock } from "./context-lock";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MobileRpcError } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { pendingThreadCreationKey } from "./pending-thread-creation";
import { isProfileStateRemovalPending } from "./profile-state-removal";
import { acknowledgeWorkspaceOperationV2, loadWorkspaceOperationReceiptV2, waitForWorkspaceOperationWritesV2 } from "./pending-workspace-operation-v2";
import type { WorkspaceScopeV2 } from "@/protocol/workspace-operation-receipts-v2";
export type WorkspaceOperationStage = "opening" | "preparing" | "checking" | "ready";
const PREFIX = "kcoder-studio:mobile-workspace-operation:v1:";
export function pendingWorkspaceOperationPrefix(profileId: string): string { return `${PREFIX}${encodeURIComponent(profileId)}:`; }
export type WorkspaceOperationKind = "open" | "create" | "worktree";
export interface WorkspaceOperationReceiptHandle {
  readonly version?: 2;
  readonly scope?: WorkspaceScopeV2;
  readonly owner?: string;
  readonly profileId: string;
  readonly authorization: WorkspaceProfileIdentity;
  readonly key: string;
  readonly id: string;
  readonly intent: string;
  readonly result: string;
  readonly completedAt: number;
  readonly consumed?: boolean;
}
export interface ConfirmedWorkspaceOperation {
  path: string;
  receipt: WorkspaceOperationReceiptHandle;
}
export interface WorkspaceOperationLocator {
  version?: 2;
  receiptId: string;
  kind: WorkspaceOperationKind;
  sourcePath: string;
}
interface WorkspaceOperationInput {
  profile: GatewayProfile; server: KCoderServer; path: string; kind: WorkspaceOperationKind; intent: string;
  prepare?(id: string): Promise<void>;
  mutate(id: string): Promise<string>; readback(id: string): Promise<string | null | undefined>;
  newIntent?: boolean;
  onProgress?(stage: WorkspaceOperationStage): void;
}
interface WorkspaceOperationRecord {
  id: string; intent: string; dispatched: boolean; completedAt?: number; result?: string; consumed?: boolean;
}
function operationKey(profile: GatewayProfile, server: KCoderServer, path: string, kind: WorkspaceOperationKind): string {
  return pendingWorkspaceOperationPrefix(profile.id) + encodeURIComponent(JSON.stringify([kind, pendingThreadCreationKey(profile, server, path)]));
}
function confirmed(authorization: WorkspaceProfileIdentity, key: string, record: WorkspaceOperationRecord): ConfirmedWorkspaceOperation {
  if (!record.completedAt || !record.result) throw new Error("工作区操作尚未确认");
  return { path: record.result, receipt: { profileId: authorization.id, authorization, key, consumed: record.consumed === true, id: record.id, intent: record.intent, result: record.result, completedAt: record.completedAt } };
}
const active = new Map<string, { intent: string; confirmed: Promise<ConfirmedWorkspaceOperation>; promise: Promise<string> }>();
// Local storage awaits can interleave in Native too. Web additionally takes the cross-tab lock.
const operationTails = new Map<string, Promise<unknown>>();
function withWorkspaceOperationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = operationTails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => withLocalIdentityLock(`workspace-operation:${key}`, operation));
  operationTails.set(key, current);
  return current.finally(() => { if (operationTails.get(key) === current) operationTails.delete(key); });
}
const pendingRecordWrites = new Map<string, Set<Promise<void>>>();
function assertProfilePresent(profileId: string): void {
  if (isProfileStateRemovalPending(profileId)) throw new Error("Gateway 已移除，操作未派发或已停止继续派发");
}
function writeRecord(authorization: WorkspaceProfileIdentity, key: string, record: WorkspaceOperationRecord): Promise<void> {
  const profileId = authorization.id;
  if (isProfileStateRemovalPending(profileId)) return Promise.reject(new WorkspaceProfileFenceError());
  const writes = pendingRecordWrites.get(profileId) ?? new Set<Promise<void>>();
  const write = Promise.resolve().then(() => withWorkspaceProfileWrite(authorization, async () => {
    if (isProfileStateRemovalPending(profileId)) throw new WorkspaceProfileFenceError();
    await AsyncStorage.setItem(key, JSON.stringify(record));
  }));
  writes.add(write); pendingRecordWrites.set(profileId, writes);
  return write.finally(() => { writes.delete(write); if (!writes.size && pendingRecordWrites.get(profileId) === writes) pendingRecordWrites.delete(profileId); });
}
export async function waitForWorkspaceOperationWrites(profileId: string): Promise<void> {
  await Promise.all([waitForWorkspaceOperationWritesV2(profileId), ...[...(pendingRecordWrites.get(profileId) ?? [])].map((write) => write.catch(() => {}))]);
}

/** Device intent only; a dispatched unknown operation is read back under the same ID, never replayed. */
export function recoverableWorkspaceOperation(input: WorkspaceOperationInput): Promise<string> {
  const job = startWorkspaceOperation(input);
  return job.promise;
}
export function recoverableWorkspaceOperationWithReceipt(input: WorkspaceOperationInput): Promise<ConfirmedWorkspaceOperation> {
  return startWorkspaceOperation(input).confirmed;
}
function startWorkspaceOperation(input: WorkspaceOperationInput) {
  const authorization = captureWorkspaceProfileIdentity(input.profile);
  const key = operationKey(input.profile, input.server, input.path, input.kind);
  const existing = active.get(key);
  if (existing) {
    if (existing.intent === input.intent) return existing;
    const rejected = Promise.reject<ConfirmedWorkspaceOperation>(new Error("该工作区仍有未完成的创建操作"));
    const promise = rejected.then((value) => value.path);
    // Either public entry point may be used; the unused projection must be observed.
    void rejected.catch(() => {}); void promise.catch(() => {});
    return { intent: input.intent, confirmed: rejected, promise };
  }
  const startedAt = Date.now();
  const operation = withWorkspaceOperationLock(key, async () => {
    const stored = await withWorkspaceProfileWrite(authorization, () => AsyncStorage.getItem(key));
    assertProfilePresent(input.profile.id);
    let record = stored ? JSON.parse(stored) as WorkspaceOperationRecord : null;
    if (record && (typeof record.id !== "string" || typeof record.intent !== "string" || typeof record.dispatched !== "boolean")) throw new Error("工作区操作记录无效");
    if (record && record.intent !== input.intent) {
      if (record.completedAt && record.consumed && input.newIntent && record.completedAt < startedAt) record = null;
      else throw new Error("还有未确认的工作区操作，请按原始参数核对");
    }
    if (record?.completedAt && record.result) {
      if (!input.newIntent || !record.consumed || record.completedAt >= startedAt) { input.onProgress?.("ready"); return confirmed(authorization, key, record); }
      record = null;
    }
    const finish = async (path: string) => {
      record = { ...record!, completedAt: Date.now(), result: path };
      await writeRecord(authorization, key, record);
      input.onProgress?.("ready");
      return confirmed(authorization, key, record);
    };
    const verify = async (definiteRemoteError?: unknown) => {
      input.onProgress?.("checking");
      assertProfilePresent(input.profile.id);
      const path = await (await startWorkspaceProfileRpc(authorization, () => input.readback(record!.id))).response;
      assertProfilePresent(input.profile.id);
      if (path === null && definiteRemoteError) { await withWorkspaceProfileWrite(authorization, () => AsyncStorage.removeItem(key)); throw definiteRemoteError; }
      if (!path) throw new Error("远程工作区操作结果仍未知，保留原始操作 ID；不会重复创建");
      return finish(path);
    };
    if (record?.dispatched) return verify();
    if (isProfileStateRemovalPending(input.profile.id)) throw new Error("Gateway 已移除，操作未派发");
    record = record ?? { id: `mobile-workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, intent: input.intent, dispatched: false };
    await writeRecord(authorization, key, record);
    assertProfilePresent(input.profile.id);
    if (input.prepare) await (await startWorkspaceProfileRpc(authorization, () => input.prepare!(record!.id))).response;
    assertProfilePresent(input.profile.id);
    record = { ...record, dispatched: true };
    await writeRecord(authorization, key, record);
    input.onProgress?.(input.kind === "open" ? "opening" : "preparing");
    assertProfilePresent(input.profile.id);
    let path: string;
    try { path = await (await startWorkspaceProfileRpc(authorization, () => input.mutate(record!.id))).response; }
    catch (error) {
      if (error instanceof MobileRpcError && error.delivery === "not-sent") { await withWorkspaceProfileWrite(authorization, () => AsyncStorage.removeItem(key)); throw error; }
      // A remote error may follow mkdir/registry/worktree side effects. Only a
      // missing receipt after a definite rejection proves no reservation began.
      return verify(error instanceof MobileRpcError && error.reason === "remote" ? error : undefined);
    }
    return finish(path);
  }).finally(() => { if (active.get(key)?.confirmed === operation) active.delete(key); });
  const promise = operation.then((value) => value.path);
  void operation.catch(() => {}); void promise.catch(() => {});
  const job = { intent: input.intent, confirmed: operation, promise };
  active.set(key, job);
  return job;
}

/** The UI consumed the confirmed result; a later explicit user action may mint a new intent. */
export async function acknowledgeWorkspaceOperation(profile: GatewayProfile, server: KCoderServer, path: string, kind: "open" | "create" | "worktree"): Promise<void> {
  const authorization = captureWorkspaceProfileIdentity(profile);
  const key = pendingWorkspaceOperationPrefix(profile.id) + encodeURIComponent(JSON.stringify([kind, pendingThreadCreationKey(profile, server, path)]));
  await withWorkspaceOperationLock(key, async () => {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return;
    const record = JSON.parse(raw);
    if (record.completedAt && record.result) await writeRecord(authorization, key, { ...record, consumed: true });
  });
}

/** Read only the scoped locator, never an arbitrary storage key supplied by navigation. */
export async function loadConfirmedWorkspaceOperationReceipt(
  profile: GatewayProfile, server: KCoderServer, locator: WorkspaceOperationLocator, expectedResult: string,
): Promise<WorkspaceOperationReceiptHandle | null> {
  if (locator.version === 2) return loadWorkspaceOperationReceiptV2(profile, server, locator, expectedResult);
  if (isProfileStateRemovalPending(profile.id) || !["open", "create", "worktree"].includes(locator.kind) || !locator.receiptId || !locator.sourcePath || !expectedResult) return null;
  const authorization = captureWorkspaceProfileIdentity(profile);
  const key = operationKey(profile, server, locator.sourcePath, locator.kind);
  return withWorkspaceOperationLock(key, () => withWorkspaceProfileWrite(authorization, async () => {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw) as WorkspaceOperationRecord;
    if (record.id !== locator.receiptId || record.result !== expectedResult || typeof record.intent !== "string" || typeof record.completedAt !== "number" || !record.completedAt) return null;
    assertProfilePresent(profile.id);
    return confirmed(authorization, key, record).receipt;
  }));
}

/** V2 first verifies current remote scope; consumption remains exact local bookkeeping. */
export async function acknowledgeConfirmedWorkspaceOperation(
  receipt: WorkspaceOperationReceiptHandle,
  context?: { profile: GatewayProfile; server: KCoderServer },
): Promise<"consumed" | "pending" | "superseded" | "unverified"> {
  if (receipt.version === 2) return acknowledgeWorkspaceOperationV2(receipt, context);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await withWorkspaceOperationLock(receipt.key, () => withWorkspaceProfileWrite(receipt.authorization, async () => {
        const raw = await AsyncStorage.getItem(receipt.key);
        if (!raw) return "superseded" as const;
        const current = JSON.parse(raw) as WorkspaceOperationRecord;
        if (current.id !== receipt.id || current.intent !== receipt.intent || current.result !== receipt.result || current.completedAt !== receipt.completedAt) return "superseded" as const;
        assertProfilePresent(receipt.profileId);
        if (!current.consumed) {
          const writes = pendingRecordWrites.get(receipt.profileId) ?? new Set<Promise<void>>();
          const write = Promise.resolve().then(() => { assertProfilePresent(receipt.profileId); return AsyncStorage.setItem(receipt.key, JSON.stringify({ ...current, consumed: true })); });
          writes.add(write); pendingRecordWrites.set(receipt.profileId, writes);
          try { await write; }
          finally { writes.delete(write); if (!writes.size && pendingRecordWrites.get(receipt.profileId) === writes) pendingRecordWrites.delete(receipt.profileId); }
        }
        return "consumed" as const;
      }));
    } catch (error) {
      if (error instanceof WorkspaceProfileFenceError) return "superseded";
      // No remote request, new operation ID, or timer is created by this retry.
    }
  }
  console.warn("workspace_operation_bookkeeping_pending");
  return "pending";
}
