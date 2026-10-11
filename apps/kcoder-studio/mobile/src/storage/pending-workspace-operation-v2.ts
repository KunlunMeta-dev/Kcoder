import { readTurnReceipt } from "../../../shared/turnReceipt";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import { workspaceParamsDigestV2, workspaceReadV2, workspaceMutationV2, workspaceScopeV2, sameWorkspaceScopeV2, WORKSPACE_READ_V2, WORKSPACE_SCOPE_V2, WORKSPACE_RECEIPTS_V2, type WorkspaceScopeV2, type WorkspaceMutationMethodV2 } from "@/protocol/workspace-operation-receipts-v2";
import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc, withWorkspaceProfileWrite, WorkspaceProfileFenceError, type WorkspaceProfileIdentity } from "./workspace-profile-fence";
import { withLocalIdentityLock } from "./context-lock";
import { loadProfiles } from "./profile-store";
import { pendingThreadCreationKey, linkedThreadCreationsInsideGate, reserveWorkspaceTaskHandoffInsideGate, readWorkspaceTaskHandoff, updateWorkspaceTaskHandoff, confirmWorkspaceTaskRouteInsideGate, assertLinkedThreadCreationsResolvedInsideGate, type LinkedCreationInput, type WorkspaceTaskHandoff, type PendingThreadCreation } from "./pending-thread-creation";
import { taskClientConnector } from "@/runtime/task-runtime/connectionFactory";
import type { ConfirmedWorkspaceOperation, WorkspaceOperationKind, WorkspaceOperationLocator, WorkspaceOperationReceiptHandle, WorkspaceOperationStage } from "./pending-workspace-operation";

const PREFIX = "kcoder-studio:mobile-workspace-operation:v2:";
const INDEX = "kcoder-studio:mobile-workspace-operation:v2-index";
const MAX_RECORDS = 128;
const MAX_INDEX_BYTES = 1_000_000;
export function pendingWorkspaceOperationPrefixV2(profileId: string): string { return PREFIX + encodeURIComponent(profileId) + ":"; }
interface IndexRow { profileId: string; family: string; id: string; key: string }
interface Phase { id: string; method: WorkspaceMutationMethodV2; params: JsonRecord; digest: string; dispatched: boolean; notSent?: boolean; result?: string }
interface StoredScopeV2 { version: 2; rootId: string; scopeId: string; familyId?: string }
interface RecordV2 {
  version: 2; profileId: string; authorization: WorkspaceProfileIdentity; owner: string; family: string; scope: StoredScopeV2;
  id: string; key: string; kind: WorkspaceOperationKind; path: string; intent: string; phases: Phase[];
  result?: string; completedAt?: number; consumed?: boolean; taskBindingVersion?: 1; deliveryToNew?: { confirmed: boolean };
}
export interface WorkspacePhaseInputV2 { method: WorkspaceMutationMethodV2; params: JsonRecord; suffix?: ":source" }
export interface WorkspaceOperationInputV2 {
  profile: GatewayProfile; server: KCoderServer; scope: WorkspaceScopeV2; kind: WorkspaceOperationKind; path: string; intent: string;
  phases(id: string): WorkspacePhaseInputV2[];
  /** Already initialized client: request executor sends synchronously; never connect here. */
  request(method: string, params: JsonRecord, timeoutMs?: number): Promise<unknown>;
  onProgress?(stage: WorkspaceOperationStage): void;
}
function invalid(): never { throw new Error("本机工作区恢复记录无效；保留原 ID，请先核对原操作"); }
function path(value: string): string {
  if (!value.startsWith("/") || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || value.split("/").some(part => part === "." || part === "..")) invalid();
  return value.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
}
export function workspaceOperationOwnerV2(profile: GatewayProfile, server: KCoderServer): string {
  return JSON.stringify([profile.id, profile.baseUrl, profile.deviceId ?? null, profile.authorizationGeneration ?? `legacy:${profile.id}`, server.id, server.workspacePath ?? null, server.transport, server.host ?? null, server.user ?? null, server.port ?? null, server.command ?? null, server.profile ?? null, server.settingsFile ?? null, server.accountIdentity?.principalId ?? null, server.accountIdentity?.role ?? null]);
}
function family(scope: WorkspaceScopeV2, kind: WorkspaceOperationKind, source: string): string {
  return JSON.stringify([scope.familyId, kind, path(source)]);
}
function storedScope(value: StoredScopeV2): void {
  if (value?.version !== 2 || !/^[0-9a-f]{64}$/.test(value.rootId) || !/^[0-9a-f]{64}$/.test(value.scopeId)) invalid();
  if (value.familyId !== undefined) workspaceScopeV2(value);
}
async function index(): Promise<IndexRow[]> {
  const raw = await AsyncStorage.getItem(INDEX);
  if (!raw) return [];
  if (raw.length > MAX_INDEX_BYTES) invalid();
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > MAX_RECORDS) invalid();
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || typeof row.profileId !== "string" || typeof row.family !== "string" || typeof row.id !== "string" || typeof row.key !== "string" || !row.key.startsWith(pendingWorkspaceOperationPrefixV2(row.profileId)) || seen.has(row.id)) invalid();
    seen.add(row.id);
  }
  return value as IndexRow[];
}
async function record(row: IndexRow): Promise<RecordV2> {
  const raw = await AsyncStorage.getItem(row.key);
  if (!raw || raw.length > 65536) invalid();
  const value = JSON.parse(raw) as RecordV2;
  if (value.version !== 2 || value.id !== row.id || value.key !== row.key || value.profileId !== row.profileId || value.family !== row.family || typeof value.owner !== "string" || typeof value.intent !== "string" || typeof value.path !== "string" || !["open","create","worktree"].includes(value.kind) || !Array.isArray(value.phases) || value.phases.length < 1 || value.phases.length > 2) invalid();
  storedScope(value.scope);
  let owner: unknown; try { owner = JSON.parse(value.owner); } catch { invalid(); }
  if (!Array.isArray(owner) || owner[0] !== value.profileId || !value.authorization || value.authorization.id !== owner[0] || value.authorization.baseUrl !== owner[1] || (value.authorization.deviceId ?? null) !== owner[2] || value.authorization.authorizationGeneration !== owner[3] ||
      value.consumed !== undefined && typeof value.consumed !== "boolean" || value.completedAt !== undefined && (typeof value.completedAt !== "number" || !Number.isFinite(value.completedAt) || value.completedAt <= 0)) invalid();
  if (owner.length !== 15 || typeof owner[4] !== "string" || value.family !== (value.scope.familyId ? family(workspaceScopeV2(value.scope), value.kind, value.path) : JSON.stringify([value.profileId, owner[1], owner[4], value.kind, path(value.path)])) || value.key !== pendingWorkspaceOperationPrefixV2(value.profileId) + encodeURIComponent(JSON.stringify([value.owner, value.scope.rootId, value.scope.scopeId, value.kind, path(value.path), value.id]))) invalid();
  if (value.kind === "worktree" ? value.phases.length !== 2 : value.phases.length !== 1) invalid();
  for (const [position, phase] of value.phases.entries()) {
    if (typeof phase.id !== "string" || !["runtime.workspaces.openV2","runtime.workspaces.prepareV2","runtime.worktrees.prepareV2"].includes(phase.method) || typeof phase.dispatched !== "boolean" || phase.notSent !== undefined && typeof phase.notSent !== "boolean" || phase.result !== undefined && typeof phase.result !== "string" || !phase.params || phase.params.clientRequestId !== phase.id || phase.params.scopeId !== value.scope.scopeId || phase.digest !== workspaceParamsDigestV2(phase.method, phase.params)) invalid();
    const expectedMethod = value.kind === "worktree" ? position === 0 ? "runtime.workspaces.openV2" : "runtime.worktrees.prepareV2" : value.kind === "open" ? "runtime.workspaces.openV2" : "runtime.workspaces.prepareV2";
    if (phase.method !== expectedMethod || phase.id !== value.id + (value.kind === "worktree" && position === 0 ? ":source" : "") || phase.result !== undefined && path(phase.result) !== phase.result) invalid();
  }
  if (value.deliveryToNew && typeof value.deliveryToNew.confirmed !== "boolean" || value.taskBindingVersion !== undefined && value.taskBindingVersion !== 1) invalid();
  if (value.result !== undefined && (typeof value.result !== "string" || !value.completedAt || value.phases.some(phase => !phase.result))) invalid();
  return value;
}
async function put(value: RecordV2): Promise<void> {
  const raw = JSON.stringify(value); if (raw.length > 65536) invalid();
  await AsyncStorage.setItem(value.key, raw);
}
function handle(value: RecordV2): ConfirmedWorkspaceOperation {
  if (!value.result || !value.completedAt) invalid();
  return { path: value.result, receipt: { version: 2, profileId: value.profileId, authorization: value.authorization, key: value.key, id: value.id, intent: value.intent, result: value.result, completedAt: value.completedAt, consumed: value.consumed, scope: workspaceScopeV2(value.scope), owner: value.owner } };
}
const jobs = new Map<string, Promise<ConfirmedWorkspaceOperation>>();
const pendingWrites = new Map<string, Set<Promise<unknown>>>();
function gate<T>(authorization: WorkspaceProfileIdentity, body: () => Promise<T>): Promise<T> {
  const writes = pendingWrites.get(authorization.id) ?? new Set<Promise<unknown>>();
  const operation = withWorkspaceProfileWrite(authorization, body);
  writes.add(operation); pendingWrites.set(authorization.id, writes);
  return operation.finally(() => { writes.delete(operation); if (!writes.size && pendingWrites.get(authorization.id) === writes) pendingWrites.delete(authorization.id); });
}
export async function waitForWorkspaceOperationWritesV2(profileId: string): Promise<void> { await Promise.all([...(pendingWrites.get(profileId) ?? [])].map(value => value.catch(() => {}))); }

interface LegacyCandidate { key: string; raw: string; profileId: string; owner: string; unresolved: boolean }
async function legacyCandidates(profileId?: string, targetId?: string, kind?: WorkspaceOperationKind, source?: string): Promise<LegacyCandidate[]> {
  const keys = await AsyncStorage.getAllKeys(); if (keys.length > 10_000) invalid();
  const prefix = "kcoder-studio:mobile-workspace-operation:v1:";
  const result: LegacyCandidate[] = [];
  for (const key of keys.filter(key => key.startsWith(prefix))) {
    const separator = key.indexOf(":", prefix.length); if (separator < 0) invalid();
    const originalProfileId = decodeURIComponent(key.slice(prefix.length, separator));
    if (profileId !== undefined && originalProfileId !== profileId) continue;
    let parts: unknown; try { parts = JSON.parse(decodeURIComponent(key.slice(separator + 1))); } catch { invalid(); }
    if (!Array.isArray(parts) || typeof parts[0] !== "string" || typeof parts[1] !== "string") invalid();
    const nestedPrefix = `kcoder-studio:mobile-thread-creation:v1:${encodeURIComponent(originalProfileId)}:`;
    if (!parts[1].startsWith(nestedPrefix)) invalid();
    let owner: unknown; try { owner = JSON.parse(decodeURIComponent(parts[1].slice(nestedPrefix.length))); } catch { invalid(); }
    if (!Array.isArray(owner) || typeof owner[2] !== "string" || typeof owner.at(-1) !== "string") invalid();
    if (targetId !== undefined && (owner[2] !== targetId || parts[0] !== kind || path(owner.at(-1)) !== source)) continue;
    const raw = await AsyncStorage.getItem(key); if (!raw || raw.length > 65536) invalid();
    const old = JSON.parse(raw);
    if (typeof old.id !== "string" || typeof old.dispatched !== "boolean" || typeof old.intent !== "string") invalid();
    if (result.length >= MAX_RECORDS) throw new Error("旧版回执核对数量已达上限；原记录已保留，不会派发新操作");
    result.push({ key, raw, profileId: originalProfileId, owner: parts[1], unresolved: old.consumed !== true || typeof old.completedAt !== "number" || !Number.isFinite(old.completedAt) || old.completedAt <= 0 || typeof old.result !== "string" || !old.result });
  }
  return result;
}
/** Opaque operation-local source connection. It caches transport, never scope evidence. */
class WorkspaceScopeSession {
  private active = true;
  private readonly authorization: WorkspaceProfileIdentity;
  private readonly owner: string;
  private constructor(
    readonly profile: GatewayProfile,
    readonly server: KCoderServer,
    private readonly originalProfile: GatewayProfile,
    private readonly originalServer: KCoderServer,
    private readonly client: Awaited<ReturnType<typeof taskClientConnector>>,
    private readonly isCurrent: () => boolean,
  ) {
    this.authorization = captureWorkspaceProfileIdentity(profile);
    this.owner = workspaceOperationOwnerV2(profile, server);
  }
  static async open(profile: GatewayProfile, server: KCoderServer, isCurrent: () => boolean): Promise<WorkspaceScopeSession> {
    const capturedProfile = { ...profile };
    const capturedServer = Object.freeze({ ...server, ...(server.accountIdentity ? { accountIdentity: Object.freeze({ ...server.accountIdentity }) } : {}) });
    const owner = workspaceOperationOwnerV2(capturedProfile, capturedServer);
    if (!isCurrent()) throw new WorkspaceProfileFenceError();
    const client = await taskClientConnector(capturedProfile, capturedServer, capturedServer.workspacePath);
    const session = new WorkspaceScopeSession(capturedProfile, capturedServer, profile, server, client, isCurrent);
    try {
      if (owner !== workspaceOperationOwnerV2(profile, server) || owner !== workspaceOperationOwnerV2(capturedProfile, capturedServer)) throw new WorkspaceProfileFenceError();
      session.assertCurrent();
      if (!client.supportsExperimental(WORKSPACE_RECEIPTS_V2)) throw new Error("目标不支持安全工作区回执；原 ID 已保留");
      return session;
    } catch (error) { session.finish(); throw error; }
  }
  assertCurrent(): void {
    if (!this.active || !this.isCurrent() || this.owner !== workspaceOperationOwnerV2(this.originalProfile, this.originalServer) || this.owner !== workspaceOperationOwnerV2(this.profile, this.server)) throw new WorkspaceProfileFenceError();
  }
  /** Every call sends fresh scope; responses and the storage body remain outside the send gate. */
  async withScope<T>(body: (scope: WorkspaceScopeV2) => Promise<T>): Promise<T> {
    this.assertCurrent();
    const started = await startWorkspaceProfileRpc(this.authorization, () => {
      this.assertCurrent();
      return this.client.request(WORKSPACE_SCOPE_V2, {});
    });
    const scope = workspaceScopeV2(await started.response);
    this.assertCurrent();
    const result = await body(scope);
    this.assertCurrent();
    return result;
  }
  finish(): void {
    if (!this.active) return;
    this.active = false;
    // Source cleanup must not turn a committed result into failed creation cleanup.
    try { this.client.close(); }
    catch {
      // Do not include transport errors, URLs or credentials, or let logging mask the body.
      try { console.warn("workspace_scope_cleanup_pending"); } catch { /* Best-effort diagnostic. */ }
    }
  }
}
/** No pooled lifetime or reconnect. The callback owns one exact default-root transport. */
export async function withWorkspaceScopeSession<T>(profile: GatewayProfile, server: KCoderServer, body: (session: WorkspaceScopeSession) => Promise<T>, isCurrent: () => boolean = () => true): Promise<T> {
  const session = await WorkspaceScopeSession.open(profile, server, isCurrent);
  try { return await body(session); } finally { session.finish(); }
}
/** Standalone callers preserve one connect/query/close, with no saved authority. */
async function withCurrentScope<T>(profile: GatewayProfile, server: KCoderServer, body: (scope: WorkspaceScopeV2) => Promise<T>): Promise<T> {
  return withWorkspaceScopeSession(profile, server, session => session.withScope(body));
}
/** Resolve an old profile only with its captured key and still-authenticated credentials; never migrate its receipt. */
async function legacyFamilyProofs(input: WorkspaceOperationInputV2, authorization: WorkspaceProfileIdentity, source: string): Promise<Map<string, { raw: string; familyId: string }>> {
  const candidates = await gate(authorization, () => legacyCandidates(undefined, input.server.id, input.kind, source));
  const proofs = new Map<string, { raw: string; familyId: string }>();
  if (!candidates.some(value => value.unresolved)) return proofs;
  const profiles = (await loadProfiles()).profiles;
  const confirmations = new Map<string, Promise<WorkspaceScopeV2>>();
  for (const candidate of candidates.filter(value => value.unresolved)) {
    const original = candidate.profileId === input.profile.id ? input.profile : profiles.find(value => value.id === candidate.profileId);
    if (!original?.deviceId || !original.authorizationGeneration || candidate.owner !== pendingThreadCreationKey(original, input.server, source)) continue;
    try {
      let confirmation = confirmations.get(original.id);
      if (!confirmation) {
        confirmation = original.id === input.profile.id ? Promise.resolve(workspaceScopeV2(input.scope)) : withCurrentScope(original, input.server, async scope => scope);
        confirmations.set(original.id, confirmation);
      }
      const confirmed = await confirmation;
      proofs.set(candidate.key, { raw: candidate.raw, familyId: confirmed.familyId });
    } catch { /* Missing original authority remains a visible, unverified blocker. */ }
  }
  return proofs;
}
async function assertLegacyResolved(profileId?: string, targetId?: string, kind?: WorkspaceOperationKind, source?: string, scope?: WorkspaceScopeV2, proofs?: Map<string, { raw: string; familyId: string }>): Promise<void> {
  for (const candidate of await legacyCandidates(profileId, targetId, kind, source)) {
    if (!candidate.unresolved) continue;
    const proof = proofs?.get(candidate.key);
    if (scope && proof?.raw === candidate.raw && proof.familyId !== scope.familyId) continue;
    throw new Error("旧版工作区操作归属未确认；原 ID 已保留，请恢复原连接核对，不会重复创建");
  }
}

export function recoverableWorkspaceOperationV2(input: WorkspaceOperationInputV2): Promise<ConfirmedWorkspaceOperation> {
  const source = path(input.path), scope = workspaceScopeV2(input.scope);
  const authorization = captureWorkspaceProfileIdentity(input.profile), owner = workspaceOperationOwnerV2(input.profile, input.server);
  const familyId = family(scope, input.kind, source), jobKey = JSON.stringify([familyId, owner, scope, input.intent]);
  const prior = jobs.get(jobKey); if (prior) return prior;
  let current: RecordV2;
  const operation = (async () => {
    const legacyProofs = await legacyFamilyProofs(input, authorization, source);
    current = await gate(authorization, async () => {
      await assertLegacyResolved(undefined, input.server.id, input.kind, source, scope, legacyProofs);
      const rows = await index(); let candidate: RecordV2 | undefined;
      const linkedFamily = (await linkedThreadCreationsInsideGate()).filter(({ value }) => value.linked!.receipt.scope?.familyId === scope.familyId && value.linked!.kind === input.kind && value.linked!.sourcePath === source);
      if (linkedFamily.some(({ value }) => !rows.some(row => row.id === value.linked!.receipt.id))) throw new Error("原任务交接回执缺失；创建 ID 已保留，不会生成新操作");
      const linkedIds = new Set(linkedFamily.map(({ value }) => value.linked!.receipt.id));
      for (const row of rows) {
        let rowFamily: unknown; try { rowFamily = JSON.parse(row.family); } catch { invalid(); }
        if (!Array.isArray(rowFamily)) invalid();
        if (rowFamily.length === 3) { if (row.family !== familyId) continue; }
        else if (rowFamily.length === 5) { if (rowFamily[2] !== input.server.id || rowFamily[3] !== input.kind || path(rowFamily[4]) !== source) continue; }
        else invalid();
        const value = await record(row);
        if (value.consumed && value.completedAt && (!value.deliveryToNew || value.deliveryToNew.confirmed) && !linkedIds.has(value.id)) {
          if (value.taskBindingVersion !== 1) throw new Error("旧工作区回执没有可信任务交接证明；请核对原任务，不会生成新操作 ID");
          continue;
        }
        if (!value.scope.familyId || value.owner !== owner || !sameWorkspaceScopeV2(workspaceScopeV2(value.scope), scope) || value.intent !== input.intent) throw new Error("原工作区操作仍未确认；请恢复原身份与配置，保留原 ID");
        const expected = input.phases(value.id);
        if (expected.length !== value.phases.length || expected.some((phase, position) => phase.method !== value.phases[position].method || workspaceParamsDigestV2(phase.method, { ...phase.params, scopeId: scope.scopeId, clientRequestId: value.id + (phase.suffix ?? "") }) !== value.phases[position].digest)) throw new Error("操作参数与原 ID 不匹配；原记录已保留");
        if (candidate) invalid(); candidate = value;
      }
      if (candidate) return candidate;
      if (rows.length >= MAX_RECORDS) throw new Error("本机工作区回执容量已满；旧 ID 已保留，不会自动删除或重试创建");
      const id = `mobile-workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      if (rows.some(row => row.id === id)) throw new Error("无法分配新的工作区操作 ID；原记录已保留，请稍后重试");
      const key = pendingWorkspaceOperationPrefixV2(input.profile.id) + encodeURIComponent(JSON.stringify([owner, scope.rootId, scope.scopeId, input.kind, source, id]));
      const phases = input.phases(id).map(phase => {
        const phaseId = id + (phase.suffix ?? ""), params = { ...phase.params, scopeId: scope.scopeId, clientRequestId: phaseId };
        return { id: phaseId, method: phase.method, params, digest: workspaceParamsDigestV2(phase.method, params), dispatched: false };
      });
      if (phases.length < 1 || phases.length > 2) invalid();
      const value: RecordV2 = { version: 2, profileId: input.profile.id, authorization, owner, family: familyId, scope, id, key, kind: input.kind, path: source, intent: input.intent, phases, taskBindingVersion: 1 };
      const next = [...rows, { profileId: input.profile.id, family: familyId, id, key }];
      const serialized = JSON.stringify(next); if (serialized.length > MAX_INDEX_BYTES) invalid();
      // Register the ID before its record. A crash leaves an inert blocker, not permission to mint again.
      await AsyncStorage.setItem(INDEX, serialized); await put(value); return value;
    });
    for (let position = 0; position < current.phases.length; position++) {
      let phase = current.phases[position];
      const read = async () => {
        input.onProgress?.("checking");
        const started = await gate(authorization, async () => {
          const exact = await record({ ...current });
          if (exact.owner !== owner || exact.id !== current.id || exact.phases[position].digest !== phase.digest) invalid();
          return { response: input.request(WORKSPACE_READ_V2, { clientRequestId: phase.id, scopeId: scope.scopeId }) };
        });
        const receipt = workspaceReadV2(await started.response, scope, phase.id, phase.method, phase.digest);
        if (!receipt || receipt.status !== "ready") throw new Error("远程工作区结果仍未知；保留原 ID，不会重派或生成新 ID");
        return receipt.workspacePath!;
      };
      let result: string;
      if (phase.dispatched && !phase.notSent) result = await read();
      else {
        const started = await gate(authorization, async () => {
          const exact = await record({ ...current });
          phase = exact.phases[position];
          if (exact.owner !== owner || exact.id !== current.id || exact.intent !== input.intent || phase.dispatched && !phase.notSent || position > 0 && !exact.phases[position-1].result) invalid();
          phase = { ...phase, dispatched: true, notSent: false }; exact.phases[position] = phase; await put(exact); current = exact;
          input.onProgress?.(position === 0 && input.kind === "worktree" || input.kind === "open" ? "opening" : "preparing");
          return { response: input.request(phase.method, phase.params, input.kind === "worktree" ? 60_000 : undefined) };
        });
        try { result = workspaceMutationV2(await started.response, scope, phase.id, phase.method, phase.digest).workspacePath!; }
        catch (error) {
          if (error instanceof MobileRpcError && error.delivery === "not-sent") {
            await gate(authorization, async () => { const exact = await record({ ...current }); if (exact.phases[position].digest !== phase.digest) invalid(); exact.phases[position].notSent = true; await put(exact); });
            throw error;
          }
          if (error instanceof MobileRpcError && error.code === -32032) throw new Error("目标工作区回执容量已满；原 ID 已保留，不会自动重试或删除记录");
          result = await read();
        }
      }
      const fresh = await startWorkspaceProfileRpc(authorization, () => input.request(WORKSPACE_SCOPE_V2, {}));
      if (!sameWorkspaceScopeV2(workspaceScopeV2(await fresh.response), scope)) throw new Error("工作区身份已变化；原 ID 和结果尚待核对，不会继续派发");
      current = await gate(authorization, async () => {
        const exact = await record({ ...current });
        if (exact.owner !== owner || exact.phases[position].digest !== phase.digest) invalid();
        exact.phases[position] = { ...exact.phases[position], result };
        if (position === exact.phases.length - 1) { exact.result = result; exact.completedAt = exact.completedAt ?? Date.now(); }
        await put(exact); return exact;
      });
    }
    input.onProgress?.("ready"); return handle(current);
  })();
  jobs.set(jobKey, operation);
  void operation.finally(() => { if (jobs.get(jobKey) === operation) jobs.delete(jobKey); }).catch(() => {});
  return operation;
}

/** Invoked inside coordinator's existing profile-index transaction, before persistence. */
export async function assertWorkspaceOperationsResolvedV2(profile: GatewayProfile): Promise<void> {
  await assertLegacyResolved(profile.id);
  await assertLinkedThreadCreationsResolvedInsideGate(profile.id);
  for (const row of (await index()).filter(row => row.profileId === profile.id)) {
    const value = await record(row);
    if (!value.consumed || !value.completedAt || !value.result || value.deliveryToNew && !value.deliveryToNew.confirmed) throw new Error("仍有未确认的工作区操作；连接与原 ID 已保留，请先核对结果再移除");
  }
}
export async function loadWorkspaceOperationReceiptV2(profile: GatewayProfile, server: KCoderServer, locator: WorkspaceOperationLocator, expectedResult: string): Promise<WorkspaceOperationReceiptHandle | null> {
  const authorization = captureWorkspaceProfileIdentity(profile), owner = workspaceOperationOwnerV2(profile, server);
  return withCurrentScope(profile, server, scope => gate(authorization, async () => {
    const rows = (await index()).filter(row => row.id === locator.receiptId && row.profileId === profile.id);
    if (rows.length !== 1) return null;
    const value = await record(rows[0]);
    if (!value.scope.familyId || !sameWorkspaceScopeV2(workspaceScopeV2(value.scope), scope) || value.owner !== owner || value.kind !== locator.kind || value.path !== path(locator.sourcePath) || value.result !== expectedResult || !value.completedAt) return null;
    return handle(value).receipt;
  }));
}
export async function acknowledgeWorkspaceOperationV2(receipt: WorkspaceOperationReceiptHandle, context?: { profile: GatewayProfile; server: KCoderServer }): Promise<"consumed" | "pending" | "superseded" | "unverified"> {
  if (!context || !receipt.scope || receipt.owner !== workspaceOperationOwnerV2(context.profile, context.server)) return "unverified";
  try {
    return await withCurrentScope(context.profile, context.server, async scope => {
      if (!sameWorkspaceScopeV2(receipt.scope!, scope)) return "unverified";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await gate(receipt.authorization, async () => {
            const row = (await index()).find(row => row.id === receipt.id && row.key === receipt.key && row.profileId === receipt.profileId);
            if (!row) return "superseded" as const;
            const value = await record(row);
            if (!value.scope.familyId || value.owner !== receipt.owner || !sameWorkspaceScopeV2(workspaceScopeV2(value.scope), scope) || value.intent !== receipt.intent || value.result !== receipt.result || value.completedAt !== receipt.completedAt) return "superseded" as const;
            if (!value.consumed) await put({ ...value, consumed: true });
            return "consumed" as const;
          });
        } catch (error) { if (error instanceof WorkspaceProfileFenceError) return "unverified"; }
      }
      console.warn("workspace_operation_v2_bookkeeping_pending"); return "pending";
    });
  } catch { return "unverified"; }
}
export async function removeWorkspaceOperationRecordsV2(profileId: string): Promise<void> {
  await waitForWorkspaceOperationWritesV2(profileId);
  return withLocalIdentityLock("gateway-profile-index", async () => {
    await assertLinkedThreadCreationsResolvedInsideGate(profileId);
    const rows = await index(), selected = rows.filter(row => row.profileId === profileId);
    for (const row of selected) { const value = await record(row); if (!value.consumed || !value.completedAt || value.deliveryToNew && !value.deliveryToNew.confirmed) invalid(); }
    const remaining = rows.filter(row => row.profileId !== profileId);
    if (remaining.length) await AsyncStorage.setItem(INDEX, JSON.stringify(remaining));
    else await AsyncStorage.removeItem(INDEX);
    if (selected.length) await AsyncStorage.multiRemove(selected.map(row => row.key));
  });
}

async function exactReceiptInsideGate(profile: GatewayProfile, server: KCoderServer, receipt: WorkspaceOperationReceiptHandle, scope: WorkspaceScopeV2): Promise<RecordV2> {
  const row = (await index()).find(row => row.id === receipt.id && row.key === receipt.key && row.profileId === profile.id);
  if (!row) invalid(); const value = await record(row);
  if (!value.scope.familyId || value.owner !== workspaceOperationOwnerV2(profile, server) || value.owner !== receipt.owner || value.intent !== receipt.intent || value.result !== receipt.result || value.completedAt !== receipt.completedAt || !sameWorkspaceScopeV2(workspaceScopeV2(value.scope), scope) || !receipt.scope || !sameWorkspaceScopeV2(receipt.scope, scope)) throw new Error("原任务工作区身份尚未核对；回执和创建 ID 已保留");
  return value;
}
export async function reserveWorkspaceTaskHandoff(profile: GatewayProfile, server: KCoderServer, receipt: WorkspaceOperationReceiptHandle, input: LinkedCreationInput): Promise<WorkspaceTaskHandoff> {
  const authorization = captureWorkspaceProfileIdentity(profile);
  return withCurrentScope(profile, server, scope => gate(authorization, async () => {
    const value = await exactReceiptInsideGate(profile, server, receipt, scope);
    const links = await linkedThreadCreationsInsideGate();
    const existing = links.find(({ value: pending }) => pending.linked!.receipt.id === receipt.id);
    if (!existing && value.taskBindingVersion !== 1) throw new Error("旧工作区回执没有可信任务交接记录；请核对原创建 ID，不会创建第二个任务");
    for (const { value: pending } of links) if (pending.linked!.receipt.scope?.familyId === scope.familyId && pending.linked!.kind === value.kind && pending.linked!.sourcePath === value.path && pending.linked!.receipt.id !== receipt.id) throw new Error("原任务交接尚未完成；不会为另一回执创建任务");
    return reserveWorkspaceTaskHandoffInsideGate(profile, server, receipt, value.kind, value.path, input);
  }));
}
type WorkspaceHandoffQuery = { kind?: WorkspaceOperationKind; sourcePath?: string; receiptId?: string; creationRequestId?: string; cwd?: string; threadId?: string };
async function hasWorkspaceTaskHandoff(profile: GatewayProfile, query: WorkspaceHandoffQuery): Promise<boolean> {
  const authorization = captureWorkspaceProfileIdentity(profile);
  return await gate(authorization, async () => (await linkedThreadCreationsInsideGate()).some(({ value }) => {
    const link = value.linked!;
    if (query.creationRequestId) return value.clientRequestId === query.creationRequestId;
    if (query.receiptId) return link.receipt.id === query.receiptId;
    if (query.threadId && value.threadId !== query.threadId) return false;
    return (query.kind === undefined || link.kind === query.kind) && (query.sourcePath === undefined || link.sourcePath === path(query.sourcePath)) && (query.cwd === undefined || link.input.cwd === path(query.cwd));
  }));
}
async function loadWorkspaceTaskHandoffInSession(session: WorkspaceScopeSession, query: WorkspaceHandoffQuery): Promise<{ handle: WorkspaceTaskHandoff; value: PendingThreadCreation } | null> {
  const { profile, server } = session;
  const authorization = captureWorkspaceProfileIdentity(profile);
  session.assertCurrent();
  return session.withScope(scope => gate(authorization, async () => {
    session.assertCurrent();
    const matches = (await linkedThreadCreationsInsideGate()).filter(({ value }) => {
      const link = value.linked!;
      if (query.creationRequestId) return value.clientRequestId === query.creationRequestId;
      if (query.receiptId) return link.receipt.id === query.receiptId;
      if (query.threadId && value.threadId !== query.threadId) return false;
      return link.receipt.scope?.familyId === scope.familyId && (query.kind === undefined || link.kind === query.kind) && (query.sourcePath === undefined || link.sourcePath === path(query.sourcePath)) && (query.cwd === undefined || link.input.cwd === path(query.cwd));
    });
    if (!matches.length) return null; if (matches.length !== 1) invalid();
    await exactReceiptInsideGate(profile, server, matches[0].value.linked!.receipt, scope);
    session.assertCurrent();
    return matches[0];
  }));
}
export async function loadWorkspaceTaskHandoff(profile: GatewayProfile, server: KCoderServer, query: WorkspaceHandoffQuery): Promise<{ handle: WorkspaceTaskHandoff; value: PendingThreadCreation } | null> {
  // Preserve the no-link ordinary task path without opening a connection.
  if (!await hasWorkspaceTaskHandoff(profile, query)) return null;
  return withWorkspaceScopeSession(profile, server, session => loadWorkspaceTaskHandoffInSession(session, query));
}
export async function verifyWorkspaceTaskHandoff(profile: GatewayProfile, server: KCoderServer, handoff: WorkspaceTaskHandoff): Promise<PendingThreadCreation> {
  const loaded = await loadWorkspaceTaskHandoff(profile, server, { creationRequestId: handoff.clientRequestId });
  if (!loaded || loaded.handle.key !== handoff.key || loaded.handle.receiptId !== handoff.receiptId) invalid();
  return loaded.value;
}
/** Existing phase verifier with a borrowed, operation-local source transport. */
export async function verifyWorkspaceTaskHandoffInSession(session: WorkspaceScopeSession, handoff: WorkspaceTaskHandoff): Promise<PendingThreadCreation> {
  session.assertCurrent();
  if (!await hasWorkspaceTaskHandoff(session.profile, { creationRequestId: handoff.clientRequestId })) invalid();
  session.assertCurrent();
  const loaded = await loadWorkspaceTaskHandoffInSession(session, { creationRequestId: handoff.clientRequestId });
  if (!loaded || loaded.handle.key !== handoff.key || loaded.handle.receiptId !== handoff.receiptId) invalid();
  return loaded.value;
}
/** Network qualification precedes the gate; current UI ownership is checked again inside it. */
export async function confirmWorkspaceTaskRoute(profile: GatewayProfile, server: KCoderServer, handoff: WorkspaceTaskHandoff, threadId: string, isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent()) return false;
  return withWorkspaceScopeSession(profile, server, async session => {
    const pending = await verifyWorkspaceTaskHandoffInSession(session, handoff), link = pending.linked!;
    const client = await taskClientConnector(profile, server, link.input.cwd);
    let scope: WorkspaceScopeV2;
    try {
      const sent = await startWorkspaceProfileRpc(link.authorization, () => client.request(WORKSPACE_SCOPE_V2, {})); scope = workspaceScopeV2(await sent.response);
      if (!link.taskScope || !sameWorkspaceScopeV2(link.taskScope, scope)) throw new Error("原任务目录身份尚未确认；创建 ID 已保留");
      if (["sent","unknown"].includes(link.turn.phase) && link.turn.params && client.supportsExperimental("turnReceiptsV1")) {
        try {
          const result = await readTurnReceipt(client, link.turn.params);
          await verifyWorkspaceTaskHandoffInSession(session, handoff);
          const fresh = await startWorkspaceProfileRpc(link.authorization, () => client.request(WORKSPACE_SCOPE_V2, {}));
          if (!sameWorkspaceScopeV2(workspaceScopeV2(await fresh.response), scope)) throw new Error("原首次发送身份已变化");
          if (isCurrent()) await updateWorkspaceTaskHandoff(handoff, value => ({ ...value, linked: { ...value.linked!, turn: { ...value.linked!.turn, phase: "accepted", turnId: result.turn!.id! } } }));
        } catch { /* Unknown never permits another turn/start; the route can still display its original task. */ }
      }
    } finally { client.close(); }
    await verifyWorkspaceTaskHandoffInSession(session, handoff);
    return gate(link.authorization, async () => {
      session.assertCurrent();
      if (!isCurrent()) return false;
      const exact = await readWorkspaceTaskHandoff(handoff);
      if (exact.threadId !== threadId || !exact.linked!.taskScope || !sameWorkspaceScopeV2(exact.linked!.taskScope, scope)) invalid();
      if (!isCurrent()) return false;
      const receipt = await exactReceiptInsideGate(profile, server, exact.linked!.receipt, exact.linked!.receipt.scope!);
      if (!isCurrent()) return false;
      return confirmWorkspaceTaskRouteInsideGate(handoff, threadId, isCurrent, receipt.consumed === true);
    });
  });
}
export async function markWorkspaceOpenDelivery(profile: GatewayProfile, server: KCoderServer, receipt: WorkspaceOperationReceiptHandle): Promise<void> {
  return withCurrentScope(profile, server, scope => gate(captureWorkspaceProfileIdentity(profile), async () => {
    const value = await exactReceiptInsideGate(profile, server, receipt, scope);
    if (!value.deliveryToNew) await put({ ...value, deliveryToNew: { confirmed: false } });
  }));
}
export async function loadWorkspaceOpenDelivery(profile: GatewayProfile, server: KCoderServer, kind: WorkspaceOperationKind, sourcePath: string): Promise<ConfirmedWorkspaceOperation | null> {
  return withCurrentScope(profile, server, scope => gate(captureWorkspaceProfileIdentity(profile), async () => {
    const matches: RecordV2[] = [];
    for (const row of (await index()).filter(row => row.family === family(scope, kind, sourcePath))) {
      const value = await record(row);
      if (value.deliveryToNew && !value.deliveryToNew.confirmed && value.result && value.completedAt) { await exactReceiptInsideGate(profile, server, handle(value).receipt, scope); matches.push(value); }
    }
    if (matches.length > 1) invalid(); return matches.length ? handle(matches[0]) : null;
  }));
}
export async function confirmWorkspaceOpenDelivery(profile: GatewayProfile, server: KCoderServer, receipt: WorkspaceOperationReceiptHandle, isCurrent: () => boolean): Promise<void> {
  return withCurrentScope(profile, server, scope => gate(captureWorkspaceProfileIdentity(profile), async () => {
    const value = await exactReceiptInsideGate(profile, server, receipt, scope);
    if (isCurrent() && value.deliveryToNew && !value.deliveryToNew.confirmed) await put({ ...value, deliveryToNew: { confirmed: true } });
  }));
}
