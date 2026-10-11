import AsyncStorage from "@react-native-async-storage/async-storage";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { withLocalIdentityLock } from "./context-lock";
import { isProfileStateRemovalPending } from "./profile-state-removal";
import type { JsonRecord } from "@/gateway/rpc";
import type { WorkspaceScopeV2 } from "@/protocol/workspace-operation-receipts-v2";
import type { WorkspaceOperationKind, WorkspaceOperationReceiptHandle } from "./pending-workspace-operation";
import { captureWorkspaceProfileIdentity, withWorkspaceProfileWrite, type WorkspaceProfileIdentity } from "./workspace-profile-fence";

// This is device recovery intent, never an authoritative session registry.
const PREFIX = "kcoder-studio:mobile-thread-creation:v1:";
export function pendingThreadCreationPrefix(profileId: string): string {
  return `${PREFIX}${encodeURIComponent(profileId)}:`;
}
export function pendingThreadCreationKey(profile: GatewayProfile, server: KCoderServer, cwd: string): string {
  return pendingThreadCreationPrefix(profile.id) + encodeURIComponent(JSON.stringify([profile.baseUrl, profile.authorizationGeneration ?? `legacy:${profile.id}`, server.id, server.transport, server.host, server.user, server.port, server.command, server.profile, server.settingsFile, server.accountIdentity?.principalId, server.accountIdentity?.role, cwd]));
}
export interface PendingThreadCreation {
  clientRequestId: string;
  intent: string;
  dispatched: boolean;
  threadId?: string;
  turnDispatched?: boolean;
  linked?: LinkedThreadCreation;
}
export interface LinkedCreationInput {
  cwd: string; prompt: string; model?: string; reasoningEffort?: string;
  sessionMode?: "default" | "orchestrate"; turnMode?: "standard" | "moa" | "moa-plan";
  managedWorktreeSourcePath?: string;
}
export interface WorkspaceTaskHandoff {
  readonly key: string; readonly clientRequestId: string; readonly receiptId: string;
}
export interface LinkedThreadCreation {
  version: 1; profileId: string; targetId: string; authorization: WorkspaceProfileIdentity;
  receipt: WorkspaceOperationReceiptHandle; kind: WorkspaceOperationKind; sourcePath: string;
  input: LinkedCreationInput; owner: string; creationIntent: string;
  taskScope?: WorkspaceScopeV2; startParams?: JsonRecord;
  threadPhase: "prepared" | "sent" | "ready" | "not-sent" | "unknown";
  turn: { clientMessageId: string; params?: JsonRecord; phase: "prepared" | "sent" | "accepted" | "not-sent" | "unknown"; turnId?: string };
  worktreeLink?: { sourcePath: string; params: JsonRecord; payloadIdentity: string; confirmed: boolean };
  routeConfirmed: boolean;
}
export async function loadPendingThreadCreation(key: string): Promise<PendingThreadCreation | null> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;
  if (raw.length > 65536) throw new Error("创建恢复记录超过限额；原 ID 已保留");
  const value = JSON.parse(raw) as PendingThreadCreation;
  if (typeof value.clientRequestId !== "string" || typeof value.intent !== "string" || typeof value.dispatched !== "boolean") throw new Error("创建恢复记录无效，请先处理本机恢复记录");
  if (value.linked) validateLinked(value, key);
  return value;
}
export async function savePendingThreadCreation(key: string, profileId: string, value: PendingThreadCreation): Promise<void> {
  if (isProfileStateRemovalPending(profileId)) throw new Error("Gateway 已移除，创建未派发");
  if (value.linked) throw new Error("已绑定的创建记录只能按原身份更新");
  await withLocalIdentityLock("gateway-profile-index", async () => {
    if (isProfileStateRemovalPending(profileId) || (await loadPendingThreadCreation(key))?.linked) throw new Error("原任务交接或连接移除尚未完成；不会覆盖原记录");
    await AsyncStorage.setItem(key, JSON.stringify(value));
  });
}
export async function clearPendingThreadCreation(key: string): Promise<void> {
  await withLocalIdentityLock("gateway-profile-index", async () => {
    const value = await loadPendingThreadCreation(key);
    if (value?.linked) throw new Error("任务交接尚未确认；原创建 ID 已保留");
    await AsyncStorage.removeItem(key);
  });
}

const linkedWrites = new Map<string, Set<Promise<unknown>>>();
function invalidLinked(): never { throw new Error("任务交接记录无效；原创建 ID 已保留，不会重新创建"); }
export function linkedCreationIntent(input: LinkedCreationInput): string {
  return JSON.stringify([input.cwd, input.prompt, input.model, input.sessionMode, input.turnMode, input.reasoningEffort, input.managedWorktreeSourcePath]);
}
function validateLinked(value: PendingThreadCreation, key: string): void {
  const link = value.linked!;
  if (link.version !== 1 || typeof link.profileId !== "string" || typeof link.targetId !== "string" || typeof link.owner !== "string" || !key.startsWith(pendingThreadCreationPrefix(link.profileId)) || link.authorization?.id !== link.profileId || link.receipt?.version !== 2 || link.receipt.profileId !== link.profileId || link.receipt.owner !== link.owner || !link.receipt.scope?.familyId || !["open","create","worktree"].includes(link.kind) || typeof link.sourcePath !== "string" || !link.sourcePath.startsWith("/") || !link.input?.cwd?.startsWith("/") || typeof link.input.prompt !== "string" || !link.input.prompt.trim() || link.input.cwd !== link.receipt.result || link.creationIntent !== linkedCreationIntent(link.input) || !["prepared","sent","ready","not-sent","unknown"].includes(link.threadPhase) || !["prepared","sent","accepted","not-sent","unknown"].includes(link.turn?.phase) || link.turn.clientMessageId !== `${value.clientRequestId}-initial-turn` || typeof link.routeConfirmed !== "boolean") invalidLinked();
  let owner: unknown; try { owner = JSON.parse(link.owner); } catch { invalidLinked(); }
  if (!Array.isArray(owner) || owner.length !== 15 || owner[0] !== link.profileId || owner[4] !== link.targetId || owner[1] !== link.authorization.baseUrl || owner[2] !== (link.authorization.deviceId ?? null) || owner[3] !== link.authorization.authorizationGeneration || JSON.stringify(link.authorization) !== JSON.stringify(link.receipt.authorization) || !link.receipt.key.startsWith(`kcoder-studio:mobile-workspace-operation:v2:${encodeURIComponent(link.profileId)}:`) || typeof link.receipt.id !== "string" || !link.receipt.id || typeof link.receipt.intent !== "string" || typeof link.receipt.completedAt !== "number" || !Number.isFinite(link.receipt.completedAt) || link.receipt.completedAt <= 0) invalidLinked();
  const receiptPrefix = `kcoder-studio:mobile-workspace-operation:v2:${encodeURIComponent(link.profileId)}:`;
  try {
    const receiptKey = JSON.parse(decodeURIComponent(link.receipt.key.slice(receiptPrefix.length)));
    const creationKey = JSON.parse(decodeURIComponent(key.slice(pendingThreadCreationPrefix(link.profileId).length)));
    if (JSON.stringify(receiptKey) !== JSON.stringify([link.owner, link.receipt.scope!.rootId, link.receipt.scope!.scopeId, link.kind, link.sourcePath, link.receipt.id]) || JSON.stringify(creationKey) !== JSON.stringify([owner[1], owner[3], owner[4], ...owner.slice(6), link.input.cwd])) invalidLinked();
  } catch { invalidLinked(); }
  if (link.startParams && (Object.keys(link.startParams).some(key => !["cwd","clientRequestId","sessionMode","model"].includes(key)) || link.startParams.sessionMode !== link.input.sessionMode || link.startParams.model !== undefined && typeof link.startParams.model !== "string")) invalidLinked();
  if (["sent","ready","unknown"].includes(link.threadPhase) && (!link.startParams || !link.taskScope)) invalidLinked();
  if (link.turn.phase !== "prepared" && !link.turn.params) invalidLinked();
  if (link.turn.params) {
    const input = link.turn.params.input;
    if (Object.keys(link.turn.params).some(key => !["threadId","clientMessageId","input","turnMode","model","reasoningEffort"].includes(key)) || !Array.isArray(input) || input.length !== 1 || input[0]?.type !== "text" || input[0]?.text !== link.input.prompt || link.turn.params.turnMode !== link.input.turnMode || link.turn.params.reasoningEffort !== link.input.reasoningEffort || link.turn.params.model !== link.startParams?.model) invalidLinked();
  }
  for (const scope of [link.receipt.scope, link.taskScope].filter(Boolean)) if (scope!.version !== 2 || !/^[0-9a-f]{64}$/.test(scope!.scopeId) || !/^[0-9a-f]{64}$/.test(scope!.rootId) || !/^[0-9a-f]{64}$/.test(scope!.familyId) || scope!.familyId !== link.receipt.scope!.familyId) invalidLinked();
  if (link.worktreeLink) {
    const conversation = link.worktreeLink.params.conversation as JsonRecord | undefined;
    if (!conversation || conversation.taskId !== value.threadId || conversation.threadId !== value.threadId || conversation.deviceId !== link.targetId || conversation.workspacePath !== link.input.cwd || link.worktreeLink.params.deviceId !== link.targetId) invalidLinked();
  }
  if (link.threadPhase === "ready" && !value.threadId || link.turn.phase === "accepted" && !link.turn.turnId) invalidLinked();
  if (link.startParams && (link.startParams.clientRequestId !== value.clientRequestId || link.startParams.cwd !== link.input.cwd)) invalidLinked();
  if (link.turn.params && (link.turn.params.clientMessageId !== link.turn.clientMessageId || link.turn.params.threadId !== value.threadId)) invalidLinked();
  if (link.worktreeLink && (link.worktreeLink.sourcePath !== link.input.managedWorktreeSourcePath || link.worktreeLink.params.path !== link.input.cwd || typeof link.worktreeLink.confirmed !== "boolean" || link.worktreeLink.payloadIdentity !== JSON.stringify(link.worktreeLink.params))) invalidLinked();
}
function immutableLink(value: PendingThreadCreation): string {
  const link = value.linked!;
  return JSON.stringify([value.clientRequestId, value.intent, link.version, link.profileId, link.targetId, link.authorization, link.receipt, link.kind, link.sourcePath, link.input, link.owner, link.creationIntent, link.turn.clientMessageId]);
}
function assertLinkedUpdate(previous: PendingThreadCreation, next: PendingThreadCreation): void {
  if (!next.linked || immutableLink(previous) !== immutableLink(next) || previous.threadId && previous.threadId !== next.threadId || previous.linked!.routeConfirmed && !next.linked.routeConfirmed || previous.linked!.turn.phase === "accepted" && (next.linked.turn.phase !== "accepted" || next.linked.turn.turnId !== previous.linked!.turn.turnId)) invalidLinked();
  for (const [before, after] of [[previous.linked!.taskScope, next.linked.taskScope], [previous.linked!.startParams, next.linked.startParams], [previous.linked!.turn.params, next.linked.turn.params], [previous.linked!.worktreeLink?.params, next.linked.worktreeLink?.params], [previous.linked!.worktreeLink?.sourcePath, next.linked.worktreeLink?.sourcePath], [previous.linked!.worktreeLink?.payloadIdentity, next.linked.worktreeLink?.payloadIdentity]]) if (before !== undefined && JSON.stringify(before) !== JSON.stringify(after)) invalidLinked();
}

function locator(key: string, value: PendingThreadCreation): WorkspaceTaskHandoff {
  return { key, clientRequestId: value.clientRequestId, receiptId: value.linked!.receipt.id };
}
export async function readWorkspaceTaskHandoff(handle: WorkspaceTaskHandoff): Promise<PendingThreadCreation> {
  const value = await loadPendingThreadCreation(handle.key);
  if (!value?.linked || value.clientRequestId !== handle.clientRequestId || value.linked.receipt.id !== handle.receiptId) invalidLinked();
  return value;
}
function tracked<T>(identity: WorkspaceProfileIdentity, body: () => Promise<T>): Promise<T> {
  const writes = linkedWrites.get(identity.id) ?? new Set<Promise<unknown>>();
  const promise = withWorkspaceProfileWrite(identity, body); writes.add(promise); linkedWrites.set(identity.id, writes);
  return promise.finally(() => { writes.delete(promise); if (!writes.size && linkedWrites.get(identity.id) === writes) linkedWrites.delete(identity.id); });
}
export async function waitForPendingThreadCreationWrites(profileId: string): Promise<void> {
  await Promise.all([...(linkedWrites.get(profileId) ?? [])].map(promise => promise.catch(() => {})));
}
async function writeLinked(key: string, value: PendingThreadCreation): Promise<void> {
  validateLinked(value, key); const raw = JSON.stringify(value); if (raw.length > 65536) invalidLinked();
  await AsyncStorage.setItem(key, raw);
}
/** Caller holds the profile-index gate and has verified this exact V2 receipt. */
export async function reserveWorkspaceTaskHandoffInsideGate(profile: GatewayProfile, server: KCoderServer, receipt: WorkspaceOperationReceiptHandle, kind: WorkspaceOperationKind, sourcePath: string, input: LinkedCreationInput): Promise<WorkspaceTaskHandoff> {
  const key = pendingThreadCreationKey(profile, server, input.cwd), existing = await loadPendingThreadCreation(key);
  if (existing) {
    if (!existing.linked || existing.linked.receipt.id !== receipt.id || existing.linked.owner !== receipt.owner || existing.linked.creationIntent !== linkedCreationIntent(input)) throw new Error("原任务创建尚未交接；请核对原创建 ID，不会绑定其他工作区回执");
    return locator(key, existing);
  }
  const keys = await AsyncStorage.getAllKeys(); if (keys.length > 10000) invalidLinked();
  const values = await linkedThreadCreationsInsideGate(); if (values.length >= 128) throw new Error("本机任务恢复记录已满；原 ID 已保留");
  const clientRequestId = `mobile-create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (values.some(({ value }) => value.clientRequestId === clientRequestId)) throw new Error("无法分配原任务创建身份；未派发新请求");
  const value: PendingThreadCreation = { clientRequestId, intent: linkedCreationIntent(input), dispatched: false,
    linked: { version: 1, profileId: profile.id, targetId: server.id, authorization: captureWorkspaceProfileIdentity(profile), receipt, kind, sourcePath, input: { ...input }, owner: receipt.owner!, creationIntent: linkedCreationIntent(input), threadPhase: "prepared", turn: { clientMessageId: `${clientRequestId}-initial-turn`, phase: "prepared" }, routeConfirmed: false } };
  await writeLinked(key, value); return locator(key, value);
}
/** Bounded local scan only; caller uses the shared profile-index gate. */
export async function linkedThreadCreationsInsideGate(): Promise<{ handle: WorkspaceTaskHandoff; value: PendingThreadCreation }[]> {
  const keys = await AsyncStorage.getAllKeys(); if (keys.length > 10000) invalidLinked();
  const result: { handle: WorkspaceTaskHandoff; value: PendingThreadCreation }[] = [];
  for (const key of keys.filter(key => key.startsWith(PREFIX))) {
    const value = await loadPendingThreadCreation(key);
    if (!value?.linked) continue;
    if (result.length >= 128) invalidLinked(); result.push({ handle: locator(key, value), value });
  }
  return result;
}
export async function updateWorkspaceTaskHandoff(handle: WorkspaceTaskHandoff, update: (value: PendingThreadCreation) => PendingThreadCreation): Promise<PendingThreadCreation> {
  const original = await readWorkspaceTaskHandoff(handle);
  return tracked(original.linked!.authorization, async () => {
    const value = await readWorkspaceTaskHandoff(handle), next = update(value);
    assertLinkedUpdate(value, next);
    await writeLinked(handle.key, next); return next;
  });
}
/** Persists dispatch and invokes a ready client's synchronous send, without holding a response Promise. */
export async function startWorkspaceTaskHandoffRpc<T>(handle: WorkspaceTaskHandoff, update: (value: PendingThreadCreation) => PendingThreadCreation, send: () => Promise<T>): Promise<{ response: Promise<T> }> {
  const original = await readWorkspaceTaskHandoff(handle);
  return tracked(original.linked!.authorization, async () => {
    const value = await readWorkspaceTaskHandoff(handle), next = update(value);
    assertLinkedUpdate(value, next);
    await writeLinked(handle.key, next); return { response: send() };
  });
}
export async function confirmWorkspaceTaskRouteInsideGate(handle: WorkspaceTaskHandoff, threadId: string, isCurrent: () => boolean, workspaceConsumed: boolean): Promise<boolean> {
  const value = await readWorkspaceTaskHandoff(handle);
  if (value.threadId !== threadId || value.linked!.threadPhase !== "ready") invalidLinked();
  if (!isCurrent()) return false;
  const next = { ...value, linked: { ...value.linked!, routeConfirmed: true } };
  if (next.linked.turn.phase === "accepted" && workspaceConsumed) await AsyncStorage.removeItem(handle.key);
  else await writeLinked(handle.key, next);
  return next.linked.turn.phase === "accepted" && workspaceConsumed;
}
export async function assertLinkedThreadCreationsResolvedInsideGate(profileId: string): Promise<void> {
  for (const { value } of await linkedThreadCreationsInsideGate()) if (value.linked!.profileId === profileId) throw new Error("仍有未完成的任务交接或首次发送；原任务和创建 ID 已保留，请先进入原任务核对");
}
