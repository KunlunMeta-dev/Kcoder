import { MAX_TASK_MESSAGE_CHARACTERS } from "@/protocol/task-message-limits";
import { legacyAttachmentPrompt } from "@/protocol/attachment-prompt";
import { isPermissionMode, type PermissionMode } from "@/protocol/task-permission-mode";
import { metadataStorage, type MetadataAuthority } from "./metadata-authority";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { withLocalMetadata } from "./context-lock";
import { isProfileStateRemovalPending } from "./profile-state-removal";
import type { JsonRecord } from "@/gateway/rpc";
import type { WorkspaceScopeV2 } from "@/protocol/workspace-operation-receipts-v2";
import type { AgentDefinitionRef } from "../../../shared/generated/contracts";
import type { WorkspaceOperationKind, WorkspaceOperationReceiptHandle } from "./pending-workspace-operation";
import { captureWorkspaceProfileIdentity, withWorkspaceProfileMetadata, type WorkspaceProfileIdentity } from "./workspace-profile-fence";
import { isAgentDefinitionRef } from "../../../shared/generated/contractGuards.mjs";
import { encodePeerUtf8 } from "../gateway/peer-transport-bytes";

// This is device recovery intent, never an authoritative session registry.
// Bounded intent + frozen input + exact first-turn wire, including legacy metadata.
export const MAX_PENDING_CREATION_CHARACTERS = 2 * 1024 * 1024;
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
  initialTurnParams?: JsonRecord;
  input?: LinkedCreationInput;
  wireModel?: string;
  initialTurnModel?: string;
  legacyAttachments?: { filename: string; mimeType: string; fileSize: number; path: string }[];
  linked?: LinkedThreadCreation;
}
export interface LinkedCreationInput {
  cwd: string; prompt: string; model?: string; reasoningEffort?: string;
  sessionMode?: "default" | "orchestrate"; turnMode?: "standard" | "moa" | "moa-plan";
  agentDefinition?: AgentDefinitionRef;
  managedWorktreeSourcePath?: string;
  permissionMode?: PermissionMode;
  localAttachmentIds?: string[];
  attachmentDraftId?: string;
  attachmentTransport?: "legacy";
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
export async function loadPendingThreadCreation(key: string, authority?: MetadataAuthority): Promise<PendingThreadCreation | null> {
  const raw = await metadataStorage(authority).getItem(key);
  if (!raw) return null;
  if (raw.length > MAX_PENDING_CREATION_CHARACTERS) throw new Error("创建恢复记录超过限额；原 ID 已保留");
  const value = JSON.parse(raw) as PendingThreadCreation;
  if (typeof value.clientRequestId !== "string" || typeof value.intent !== "string" || typeof value.dispatched !== "boolean") throw new Error("创建恢复记录无效，请先处理本机恢复记录");
  if (value.linked) validateLinked(value, key);
  else validateOrdinary(value, key);
  return value;
}
export async function savePendingThreadCreation(key: string, profileId: string, value: PendingThreadCreation): Promise<void> {
  if (isProfileStateRemovalPending(profileId)) throw new Error("Gateway 已移除，创建未派发");
  if (value.linked) throw new Error("已绑定的创建记录只能按原身份更新");
  validateOrdinary(value, key);
  const serialized = serializePending(value);
  await withLocalMetadata("gateway-profile-index", async authority => {
    const previous = await loadPendingThreadCreation(key, authority);
    if (isProfileStateRemovalPending(profileId) || previous?.linked) throw new Error("原任务交接或连接移除尚未完成；不会覆盖原记录");
    if (previous && (previous.clientRequestId !== value.clientRequestId || previous.intent !== value.intent || JSON.stringify(previous.input) !== JSON.stringify(value.input) || previous.wireModel !== value.wireModel || previous.threadId && previous.threadId !== value.threadId || previous.initialTurnParams && JSON.stringify(previous.initialTurnParams) !== JSON.stringify(value.initialTurnParams))) invalidLinked();
    await metadataStorage(authority).setItem(key, serialized);
  });
}
export async function clearPendingThreadCreation(key: string, expectedClientRequestId?: string): Promise<void> {
  await withLocalMetadata("gateway-profile-index", async authority => {
    const value = await loadPendingThreadCreation(key, authority);
    if (value?.linked) throw new Error("任务交接尚未确认；原创建 ID 已保留");
    if (expectedClientRequestId && value?.clientRequestId !== expectedClientRequestId) return;
    await metadataStorage(authority).removeItem(key);
  });
}

const linkedWrites = new Map<string, Set<Promise<unknown>>>();
function invalidLinked(): never { throw new Error("任务交接记录无效；原创建 ID 已保留，不会重新创建"); }
export function creationTurnOptions(input: Pick<LinkedCreationInput, "permissionMode" | "localAttachmentIds" | "attachmentDraftId" | "attachmentTransport">): unknown[] {
  if (input.attachmentTransport !== undefined && input.attachmentTransport !== "legacy") throw new Error("Invalid initial attachment transport");
  if (input.localAttachmentIds?.length && (typeof input.attachmentDraftId !== "string" || !input.attachmentDraftId || input.attachmentDraftId.length > 256)) throw new Error("Invalid initial attachment draft owner");
  const permissionMode = input.permissionMode === "default" ? undefined : input.permissionMode;
  if (permissionMode !== undefined && !isPermissionMode(permissionMode)) throw new Error("Invalid initial permission mode");
  if (input.localAttachmentIds && (input.localAttachmentIds.length > 32 || new Set(input.localAttachmentIds).size !== input.localAttachmentIds.length || input.localAttachmentIds.some(id => !/^[a-f0-9]{32}$/.test(id)))) throw new Error("Invalid initial attachment identity");
  return permissionMode || input.localAttachmentIds?.length ? [{ permissionMode, localAttachmentIds: input.localAttachmentIds, attachmentDraftId: input.attachmentDraftId, ...(input.attachmentTransport ? { attachmentTransport: input.attachmentTransport } : {}) }] : [];
}
function validateAgentDefinition(input: Pick<LinkedCreationInput, "agentDefinition" | "sessionMode">): void {
  const reference = input.agentDefinition as unknown;
  if (reference === undefined) return;
  if (!isAgentDefinitionRef(reference)) invalidLinked();
  const validReference = reference as AgentDefinitionRef;
  if ([validReference.id, validReference.version].some(value => !value || encodePeerUtf8(value).length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) ||
    !/^[a-f0-9]{64}$/.test(validReference.definitionSha256) ||
    input.sessionMode !== undefined && input.sessionMode !== "default") invalidLinked();
}
export function linkedCreationIntent(input: LinkedCreationInput): string {
  validateAgentDefinition(input);
  return JSON.stringify([input.cwd, input.prompt, input.model, input.sessionMode, input.turnMode, input.reasoningEffort, input.managedWorktreeSourcePath, ...creationTurnOptions(input), ...(input.agentDefinition ? [{ agentDefinition: input.agentDefinition }] : [])]);
}
/** New journal fields are optional for legacy records, but never partially trusted. */
export function originalCreationInput(value: PendingThreadCreation): LinkedCreationInput {
  if (value.input) return value.input;
  let intent: unknown;
  try { intent = JSON.parse(value.intent); } catch { invalidLinked(); }
  if (!Array.isArray(intent) || intent.length !== 7 || typeof intent[0] !== "string" || !intent[0].trim() || typeof intent[1] !== "string" || !intent[1].trim() || intent.slice(2).some(item => item !== null && typeof item !== "string")) invalidLinked();
  if (intent[3] !== null && !["default", "orchestrate"].includes(intent[3]) || intent[4] !== null && !["standard", "moa", "moa-plan"].includes(intent[4])) invalidLinked();
  return { cwd: intent[0], prompt: intent[1], model: intent[2] ?? undefined, sessionMode: intent[3] ?? undefined, turnMode: intent[4] ?? undefined, reasoningEffort: intent[5] ?? undefined, managedWorktreeSourcePath: intent[6] ?? undefined };
}
function validateOrdinary(value: PendingThreadCreation, key: string): void {
  if (value.threadId !== undefined && (typeof value.threadId !== "string" || !value.threadId) || value.turnDispatched !== undefined && typeof value.turnDispatched !== "boolean") invalidLinked();
  if (!value.input) { if (value.initialTurnParams || value.wireModel || value.initialTurnModel) invalidLinked(); return; }
  const input = value.input;
  if (Object.keys(input).some(key => !["cwd","prompt","model","reasoningEffort","sessionMode","turnMode","agentDefinition","managedWorktreeSourcePath","permissionMode","localAttachmentIds","attachmentDraftId","attachmentTransport"].includes(key)) || typeof input.cwd !== "string" || !input.cwd.trim() || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > MAX_TASK_MESSAGE_CHARACTERS) invalidLinked();
  for (const item of [input.model, input.reasoningEffort, input.managedWorktreeSourcePath, value.wireModel, value.initialTurnModel]) if (item !== undefined && (typeof item !== "string" || !item)) invalidLinked();
  if (input.sessionMode !== undefined && !["default","orchestrate"].includes(input.sessionMode) || input.turnMode !== undefined && !["standard","moa","moa-plan"].includes(input.turnMode)) invalidLinked();
  validateAgentDefinition(input);
  creationTurnOptions(input);
  const prefix = key.slice(0, key.lastIndexOf(":") + 1);
  let scope: unknown;
  try { scope = JSON.parse(decodeURIComponent(key.slice(prefix.length))); } catch { invalidLinked(); }
  if (!Array.isArray(scope) || scope.at(-1) !== input.cwd || value.intent !== JSON.stringify([input.cwd, input.prompt, value.wireModel, input.sessionMode, input.turnMode, input.reasoningEffort, input.managedWorktreeSourcePath, ...creationTurnOptions(input), ...(input.agentDefinition ? [{ agentDefinition: input.agentDefinition }] : [])])) invalidLinked();
  validateLegacyAttachments(value, input, Boolean(value.initialTurnParams));
  const params = value.initialTurnParams;
  if (value.turnDispatched && !params) invalidLinked();
  if (!params) return;
  const text = params.input;
  if (!value.threadId || Object.keys(params).some(key => !["threadId","clientMessageId","input","turnMode","model","reasoningEffort","permissionMode","retention"].includes(key)) || params.threadId !== value.threadId || params.clientMessageId !== `${value.clientRequestId}-initial-turn` || !Array.isArray(text) || text.length !== 1 || Object.keys(text[0] ?? {}).some(key => !["type","text"].includes(key)) || text[0]?.type !== "text" || text[0]?.text !== (input.attachmentTransport === "legacy" ? legacyAttachmentPrompt(input.prompt, value.legacyAttachments ?? []) : input.prompt) || params.permissionMode !== (input.permissionMode === "default" ? undefined : input.permissionMode) || params.turnMode !== input.turnMode || params.reasoningEffort !== input.reasoningEffort || params.model !== value.initialTurnModel || Boolean(params.retention) !== Boolean(input.localAttachmentIds?.length && input.attachmentTransport !== "legacy")) invalidLinked();
  if (params.retention) {
    const retention = params.retention as { references?: { retentionId?: string; expectedRevision?: number; entryIds?: string[] }[]; attachments?: { entryId?: string; filename?: string; mimeType?: string }[] };
    if (Object.keys(retention).some(key => !["references","attachments"].includes(key)) || !Array.isArray(retention.references) || retention.references.length !== 1 || !Array.isArray(retention.attachments) || retention.attachments.length !== input.localAttachmentIds!.length) invalidLinked();
    const reference = retention.references[0];
    if (!reference || typeof reference.retentionId !== "string" || !reference.retentionId || !Number.isSafeInteger(reference.expectedRevision) || reference.expectedRevision! < 0 || !Array.isArray(reference.entryIds) || reference.entryIds.length !== retention.attachments.length || new Set(reference.entryIds).size !== reference.entryIds.length || reference.entryIds.some(id => typeof id !== "string" || !id)) invalidLinked();
    if (retention.attachments.some(item => !item || !reference.entryIds!.includes(item.entryId!) || typeof item.filename !== "string" || !item.filename || typeof item.mimeType !== "string" || !item.mimeType) || new Set(retention.attachments.map(item => item.entryId)).size !== retention.attachments.length) invalidLinked();
  }
}
function validateLegacyAttachments(value: PendingThreadCreation, input: LinkedCreationInput, hasTurnParams: boolean): void {
  const attachments = value.legacyAttachments;
  if (hasTurnParams && input.attachmentTransport === "legacy" && input.localAttachmentIds?.length && !attachments) invalidLinked();
  if (!attachments) return;
  if (input.attachmentTransport !== "legacy" || !Array.isArray(attachments) || attachments.length !== input.localAttachmentIds?.length || new Set(attachments.map(item => item?.path)).size !== attachments.length || attachments.some(item => !item || Object.keys(item).some(key => !["filename","mimeType","fileSize","path"].includes(key)) || typeof item.filename !== "string" || !item.filename || item.filename.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(item.filename) || typeof item.mimeType !== "string" || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(item.mimeType) || !Number.isSafeInteger(item.fileSize) || item.fileSize < 0 || item.fileSize > 50 * 1024 * 1024 || typeof item.path !== "string" || !item.path || item.path.length > 4096 || /[\u0000-\u001f\u007f]/.test(item.path))) invalidLinked();
}
function validateLinked(value: PendingThreadCreation, key: string): void {
  const link = value.linked!;
  if (!link.input || Object.keys(link.input).some(key => !["cwd","prompt","model","reasoningEffort","sessionMode","turnMode","agentDefinition","managedWorktreeSourcePath","permissionMode","localAttachmentIds","attachmentDraftId","attachmentTransport"].includes(key))) invalidLinked();
  validateAgentDefinition(link.input);
  validateLegacyAttachments(value, link.input, Boolean(link.turn?.params));
  if (link.version !== 1 || typeof link.profileId !== "string" || typeof link.targetId !== "string" || typeof link.owner !== "string" || !key.startsWith(pendingThreadCreationPrefix(link.profileId)) || link.authorization?.id !== link.profileId || link.receipt?.version !== 2 || link.receipt.profileId !== link.profileId || link.receipt.owner !== link.owner || !link.receipt.scope?.familyId || !["open","create","worktree"].includes(link.kind) || typeof link.sourcePath !== "string" || !link.sourcePath.startsWith("/") || !link.input?.cwd?.startsWith("/") || typeof link.input.prompt !== "string" || !link.input.prompt.trim() || link.input.prompt.length > MAX_TASK_MESSAGE_CHARACTERS || link.input.cwd !== link.receipt.result || link.creationIntent !== linkedCreationIntent(link.input) || !["prepared","sent","ready","not-sent","unknown"].includes(link.threadPhase) || !["prepared","sent","accepted","not-sent","unknown"].includes(link.turn?.phase) || link.turn.clientMessageId !== `${value.clientRequestId}-initial-turn` || typeof link.routeConfirmed !== "boolean") invalidLinked();
  let owner: unknown; try { owner = JSON.parse(link.owner); } catch { invalidLinked(); }
  if (!Array.isArray(owner) || owner.length !== 15 || owner[0] !== link.profileId || owner[4] !== link.targetId || owner[1] !== link.authorization.baseUrl || owner[2] !== (link.authorization.deviceId ?? null) || owner[3] !== link.authorization.authorizationGeneration || JSON.stringify(link.authorization) !== JSON.stringify(link.receipt.authorization) || !link.receipt.key.startsWith(`kcoder-studio:mobile-workspace-operation:v2:${encodeURIComponent(link.profileId)}:`) || typeof link.receipt.id !== "string" || !link.receipt.id || typeof link.receipt.intent !== "string" || typeof link.receipt.completedAt !== "number" || !Number.isFinite(link.receipt.completedAt) || link.receipt.completedAt <= 0) invalidLinked();
  const receiptPrefix = `kcoder-studio:mobile-workspace-operation:v2:${encodeURIComponent(link.profileId)}:`;
  try {
    const receiptKey = JSON.parse(decodeURIComponent(link.receipt.key.slice(receiptPrefix.length)));
    const creationKey = JSON.parse(decodeURIComponent(key.slice(pendingThreadCreationPrefix(link.profileId).length)));
    if (JSON.stringify(receiptKey) !== JSON.stringify([link.owner, link.receipt.scope!.rootId, link.receipt.scope!.scopeId, link.kind, link.sourcePath, link.receipt.id]) || JSON.stringify(creationKey) !== JSON.stringify([owner[1], owner[3], owner[4], ...owner.slice(6), link.input.cwd])) invalidLinked();
  } catch { invalidLinked(); }
  if (link.startParams && (Object.keys(link.startParams).some(key => !["cwd","clientRequestId","sessionMode","model","agentDefinition"].includes(key)) || link.startParams.sessionMode !== link.input.sessionMode || link.startParams.model !== undefined && typeof link.startParams.model !== "string" || JSON.stringify(link.startParams.agentDefinition) !== JSON.stringify(link.input.agentDefinition))) invalidLinked();
  if (["sent","ready","unknown"].includes(link.threadPhase) && (!link.startParams || !link.taskScope)) invalidLinked();
  if (link.turn.phase !== "prepared" && !link.turn.params) invalidLinked();
  if (link.turn.params) {
    const input = link.turn.params.input;
    if (Boolean(link.turn.params.retention) !== Boolean(link.input.localAttachmentIds?.length && link.input.attachmentTransport !== "legacy")) invalidLinked();
    if (Object.keys(link.turn.params).some(key => !["threadId","clientMessageId","input","turnMode","model","reasoningEffort","permissionMode","retention"].includes(key)) || !Array.isArray(input) || input.length !== 1 || input[0]?.type !== "text" || input[0]?.text !== (link.input.attachmentTransport === "legacy" ? legacyAttachmentPrompt(link.input.prompt, value.legacyAttachments ?? []) : link.input.prompt) || link.turn.params.permissionMode !== (link.input.permissionMode === "default" ? undefined : link.input.permissionMode) || link.turn.params.turnMode !== link.input.turnMode || link.turn.params.reasoningEffort !== link.input.reasoningEffort || link.turn.params.model !== link.startParams?.model) invalidLinked();
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
export async function readWorkspaceTaskHandoff(handle: WorkspaceTaskHandoff, authority?: MetadataAuthority): Promise<PendingThreadCreation> {
  const value = await loadPendingThreadCreation(handle.key, authority);
  if (!value?.linked || value.clientRequestId !== handle.clientRequestId || value.linked.receipt.id !== handle.receiptId) invalidLinked();
  return value;
}
function tracked<T>(identity: WorkspaceProfileIdentity, body: (authority?: MetadataAuthority) => Promise<T>): Promise<T> {
  const writes = linkedWrites.get(identity.id) ?? new Set<Promise<unknown>>();
  const promise = withWorkspaceProfileMetadata(identity, body); writes.add(promise); linkedWrites.set(identity.id, writes);
  return promise.finally(() => { writes.delete(promise); if (!writes.size && linkedWrites.get(identity.id) === writes) linkedWrites.delete(identity.id); });
}
export async function waitForPendingThreadCreationWrites(profileId: string): Promise<void> {
  await Promise.all([...(linkedWrites.get(profileId) ?? [])].map(promise => promise.catch(() => {})));
}
function serializePending(value: PendingThreadCreation): string {
  const raw = JSON.stringify(value); if (raw.length > MAX_PENDING_CREATION_CHARACTERS) invalidLinked(); return raw;
}
async function writeLinked(key: string, value: PendingThreadCreation, authority?: MetadataAuthority): Promise<void> {
  validateLinked(value, key); const raw = serializePending(value);
  await metadataStorage(authority).setItem(key, raw);
}
/** Caller holds the profile-index gate and has verified this exact V2 receipt. */
export async function reserveWorkspaceTaskHandoffInsideGate(profile: GatewayProfile, server: KCoderServer, receipt: WorkspaceOperationReceiptHandle, kind: WorkspaceOperationKind, sourcePath: string, input: LinkedCreationInput, authority?: MetadataAuthority): Promise<WorkspaceTaskHandoff> {
  const key = pendingThreadCreationKey(profile, server, input.cwd), existing = await loadPendingThreadCreation(key, authority);
  if (existing) {
    if (!existing.linked || existing.linked.receipt.id !== receipt.id || existing.linked.owner !== receipt.owner || existing.linked.creationIntent !== linkedCreationIntent(input)) throw new Error("原任务创建尚未交接；请核对原创建 ID，不会绑定其他工作区回执");
    return locator(key, existing);
  }
  const keys = await metadataStorage(authority).getAllKeys(); if (keys.length > 10000) invalidLinked();
  const values = await linkedThreadCreationsInsideGate(authority); if (values.length >= 128) throw new Error("本机任务恢复记录已满；原 ID 已保留");
  const clientRequestId = `mobile-create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (values.some(({ value }) => value.clientRequestId === clientRequestId)) throw new Error("无法分配原任务创建身份；未派发新请求");
  const value: PendingThreadCreation = { clientRequestId, intent: linkedCreationIntent(input), dispatched: false,
    linked: { version: 1, profileId: profile.id, targetId: server.id, authorization: captureWorkspaceProfileIdentity(profile), receipt, kind, sourcePath, input: { ...input }, owner: receipt.owner!, creationIntent: linkedCreationIntent(input), threadPhase: "prepared", turn: { clientMessageId: `${clientRequestId}-initial-turn`, phase: "prepared" }, routeConfirmed: false } };
  await writeLinked(key, value, authority); return locator(key, value);
}
/** Bounded local scan only; caller uses the shared profile-index gate. */
export async function linkedThreadCreationsInsideGate(authority?: MetadataAuthority): Promise<{ handle: WorkspaceTaskHandoff; value: PendingThreadCreation }[]> {
  const keys = await metadataStorage(authority).getAllKeys(); if (keys.length > 10000) invalidLinked();
  const result: { handle: WorkspaceTaskHandoff; value: PendingThreadCreation }[] = [];
  for (const key of keys.filter(key => key.startsWith(PREFIX))) {
    const value = await loadPendingThreadCreation(key, authority);
    if (!value?.linked) continue;
    if (result.length >= 128) invalidLinked(); result.push({ handle: locator(key, value), value });
  }
  return result;
}
export async function updateWorkspaceTaskHandoff(handle: WorkspaceTaskHandoff, update: (value: PendingThreadCreation) => PendingThreadCreation): Promise<PendingThreadCreation> {
  const original = await readWorkspaceTaskHandoff(handle);
  return tracked(original.linked!.authorization, async authority => {
    const value = await readWorkspaceTaskHandoff(handle, authority), next = update(value);
    assertLinkedUpdate(value, next);
    await writeLinked(handle.key, next, authority); return next;
  });
}
/** Persists dispatch and invokes a ready client's synchronous send, without holding a response Promise. */
export async function startWorkspaceTaskHandoffRpc<T>(handle: WorkspaceTaskHandoff, update: (value: PendingThreadCreation) => PendingThreadCreation, send: () => Promise<T>): Promise<{ response: Promise<T> }> {
  const original = await readWorkspaceTaskHandoff(handle);
  return tracked(original.linked!.authorization, async authority => {
    const value = await readWorkspaceTaskHandoff(handle, authority), next = update(value);
    assertLinkedUpdate(value, next);
    await writeLinked(handle.key, next, authority); return authority ? authority.effect(() => ({ response: send() })) : { response: send() };
  });
}
export async function confirmWorkspaceTaskRouteInsideGate(handle: WorkspaceTaskHandoff, threadId: string, isCurrent: () => boolean, workspaceConsumed: boolean, authority?: MetadataAuthority): Promise<boolean> {
  const value = await readWorkspaceTaskHandoff(handle, authority);
  if (value.threadId !== threadId || value.linked!.threadPhase !== "ready") invalidLinked();
  if (!isCurrent()) return false;
  const next = { ...value, linked: { ...value.linked!, routeConfirmed: true } };
  if (next.linked.turn.phase === "accepted" && workspaceConsumed) await metadataStorage(authority).removeItem(handle.key);
  else await writeLinked(handle.key, next, authority);
  return next.linked.turn.phase === "accepted" && workspaceConsumed;
}
export async function assertLinkedThreadCreationsResolvedInsideGate(profileId: string, authority?: MetadataAuthority): Promise<void> {
  for (const { value } of await linkedThreadCreationsInsideGate(authority)) if (value.linked!.profileId === profileId) throw new Error("仍有未完成的任务交接或首次发送；原任务和创建 ID 已保留，请先进入原任务核对");
}
