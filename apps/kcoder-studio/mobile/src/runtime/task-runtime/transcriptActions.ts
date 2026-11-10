import { MobileRpcError, type JsonRecord } from "@/gateway/rpc";
import { t } from "@/i18n";
import { legacyAttachmentPrompt } from "@/protocol/attachment-prompt";
import { loadWorkspaceState, saveWorkspaceState, updateWorkspaceTranscriptAction, workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
import { captureWorkspaceProfileIdentity } from "@/storage/workspace-profile-fence";
import { normalizeTranscriptAction, type TranscriptActionRecord } from "@/storage/transcript-action";
import { RETAIN_TASK_ATTACHMENTS } from "../../../../shared/attachmentRetention";
import { negotiateModelSelector } from "../../../../shared/modelSelection";
import { readTurnReceipt } from "../../../../shared/turnReceipt";
import { decodeTurnMessageStatus } from "../../../../shared/turnMessageStatus";
import type { TaskRuntime } from "./core";
import { taskRuntimeRegistry, type TaskCreationRegistration } from "./registry";
import { nextOutgoingMessageSequence, outgoingMessageNamespace } from "./connectionFactory";
import { readHistoryPage } from "./history";
import { permissionParams } from "./turn-permissions";
import type { ChatMessage, TaskSnapshot } from "./types";

export function canChangeTranscript(snapshot: TaskSnapshot): boolean {
  return snapshot.connected && snapshot.configurationReady !== false && !snapshot.running &&
    !snapshot.interaction && !snapshot.archivedAt && !snapshot.sendAcceptanceUnknown &&
    !snapshot.continuationPending && !snapshot.continuationUnknown && !snapshot.transcriptActionPending &&
    !snapshot.metadataPending?.length && !snapshot.metadataUnknown?.length;
}

export function lastEditableMessage(snapshot: TaskSnapshot): ChatMessage | undefined {
  if (!canChangeTranscript(snapshot)) return undefined;
  const index = snapshot.messages.findLastIndex(message => message.role === "user");
  return index >= 0 && snapshot.messages.slice(index + 1).some(message => message.role === "assistant")
    ? snapshot.messages[index] : undefined;
}

export function completedForkMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && Boolean(message.turnId) && decodeTurnMessageStatus(message.status).status === "done";
}

function actionScope(runtime: TaskRuntime) {
  const context = runtime.reconnectContext;
  if (!context || runtime.disposed) throw new Error(t("task.transcript_owner_changed"));
  const threadId = runtime.snapshot.threadId;
  const scope = workspaceStateAuthorizationScope(context.profile, context.server);
  return {
    read: async () => (await loadWorkspaceState(context.profile.id, context.server.id, threadId, scope)).transcriptAction,
    write: async (previous: TranscriptActionRecord | undefined, next: TranscriptActionRecord | undefined) => {
      const fields = ["id", "kind", "phase", "sourceMessageId", "cwd", "turnId", "text", "wireText", "model", "reasoningEffort", "permissionMode", "childThreadId"] as const;
      const same = (actual: TranscriptActionRecord | undefined) => fields.every(field => actual?.[field] === next?.[field]);
      if (!same(normalizeTranscriptAction(next))) throw new Error(t("task.transcript_changed"));
      const saved = await updateWorkspaceTranscriptAction(context.profile.id, context.server.id, threadId, previous, next, scope, captureWorkspaceProfileIdentity(context.profile));
      if (!same(saved.transcriptAction)) throw new Error(t("task.transcript_owner_changed"));
    },
  };
}

export async function pendingTranscriptAction(this: TaskRuntime): Promise<TranscriptActionRecord | undefined> {
  const record = await actionScope(this).read();
  if (!this.disposed) this.patch({ transcriptActionPending: Boolean(record) });
  return record;
}

export async function assertNoTranscriptAction(runtime: TaskRuntime): Promise<void> {
  if (runtime.snapshot.transcriptActionPending || (runtime.reconnectContext && await actionScope(runtime).read()) || runtime.snapshot.transcriptActionPending)
    throw new MobileRpcError(t("task.transcript_action_unsettled"), -1, "transport", "not-sent");
}

function capture(runtime: TaskRuntime) {
  const client = runtime.client;
  const generation = runtime.clientGeneration;
  const context = runtime.reconnectContext;
  const cwd = runtime.snapshot.cwd;
  const threadId = runtime.snapshot.threadId;
  const current = () => !runtime.disposed && runtime.client === client && runtime.clientGeneration === generation &&
    runtime.reconnectContext === context && runtime.snapshot.cwd === cwd && runtime.snapshot.threadId === threadId;
  const check = () => {
    if (!current() || !client || !runtime.snapshot.connected) throw new Error(t("task.transcript_owner_changed"));
  };
  check();
  return { client: client!, current, check, cwd, threadId };
}

function newRecord(kind: "edit" | "fork", message: ChatMessage, text: string, cwd: string): TranscriptActionRecord {
  return { id: `mobile-transcript-${outgoingMessageNamespace}-${Date.now().toString(36)}-${nextOutgoingMessageSequence()}`,
    kind, phase: "prepared", sourceMessageId: message.id, turnId: message.turnId, text, cwd };
}

/** These RPCs have no mutation receipt. Persist dispatch before sending and never retry them automatically. */
export async function editLastMessage(this: TaskRuntime, messageId: string, text: string): Promise<void> {
  const original = lastEditableMessage(this.snapshot);
  if (!original || original.id !== messageId || !text.trim() || text.length > 50_000)
    throw new Error(t("task.transcript_changed"));
  const owner = capture(this);
  const storage = actionScope(this);
  const configuration = { model: this.snapshot.model, reasoningEffort: this.snapshot.reasoningEffort, permissionMode: this.snapshot.permissionMode ?? "default" };
  this.patch({ transcriptActionPending: true, loadingOlder: false });
  let record: TranscriptActionRecord | undefined;
  let saved = false;
  try {
    if (await storage.read()) throw new Error(t("task.transcript_action_unsettled"));
    owner.check();
    const page = await readHistoryPage(owner.client, owner.threadId);
    owner.check();
    const lastUser = page.messages.findLast(message => message.role === "user");
    const sameMessage = lastUser && (lastUser.id === original.id ||
      (original.clientMessageId && lastUser.clientMessageId === original.clientMessageId) ||
      (original.turnId && lastUser.turnId === original.turnId));
    if (page.thread?.id !== owner.threadId || page.thread.cwd !== owner.cwd || page.thread.status !== "idle" ||
        this.snapshot.running || !lastUser || !sameMessage || lastUser.content !== original.content)
      throw new Error(t("task.transcript_changed"));
    const permission = permissionParams(configuration.permissionMode, owner.client);
    const model = await negotiateModelSelector(owner.client, configuration.model);
    owner.check();
    if (this.snapshot.model !== configuration.model || this.snapshot.reasoningEffort !== configuration.reasoningEffort ||
        (this.snapshot.permissionMode ?? "default") !== configuration.permissionMode || this.snapshot.configurationReady === false || this.snapshot.running)
      throw new Error(t("task.transcript_changed"));
    record = { ...newRecord("edit", lastUser, text.trim(), owner.cwd), wireText: legacyAttachmentPrompt(text.trim(), original.attachments ?? []),
      model, reasoningEffort: configuration.reasoningEffort, ...permission };
    await storage.write(undefined, record); saved = true; owner.check();
    if (original.attachments?.length) {
      await owner.client.request(RETAIN_TASK_ATTACHMENTS, { threadId: owner.threadId, paths: original.attachments.map(attachment => attachment.path) });
      owner.check();
    }
    const dispatched: TranscriptActionRecord = { ...record, phase: "rollbackSent" };
    await storage.write(record, dispatched); record = dispatched; owner.check();
    this.transcriptMutationRevision++;
    const result = await owner.client.request<{ threadId: string; removedMessages: number; failedFiles: number }>("thread/rollback", { threadId: owner.threadId });
    owner.check();
    if (result.threadId !== owner.threadId || !Number.isInteger(result.removedMessages) || result.removedMessages <= 0 || result.failedFiles !== 0) {
      const blocked: TranscriptActionRecord = { ...record, phase: "blocked" };
      await storage.write(record, blocked); record = blocked;
      throw new Error(t("task.transcript_rollback_incomplete"));
    }
    const rolledBack: TranscriptActionRecord = { ...record, phase: "rolledBack" };
    await storage.write(record, rolledBack); record = rolledBack;
    await sendEdited(this, record, original.attachments);
  } catch (error) {
    // A prepared request has not crossed the destructive boundary and can be cancelled safely.
    if (saved && record?.phase === "prepared") { await storage.write(record, undefined); saved = false; }
    throw error;
  } finally {
    if (!this.disposed) this.patch({ transcriptActionPending: Boolean(await storage.read()) });
  }
}

function editedParams(runtime: TaskRuntime, record: TranscriptActionRecord): JsonRecord {
  if (!record.wireText) throw new Error(t("task.transcript_changed"));
  return { threadId: runtime.snapshot.threadId, clientMessageId: record.id,
    input: [{ type: "text", text: record.wireText }],
    ...(record.model ? { model: record.model } : {}),
    ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
    ...permissionParams(record.permissionMode, runtime.client) };
}

async function sendEdited(runtime: TaskRuntime, record: TranscriptActionRecord, attachments?: ChatMessage["attachments"]): Promise<void> {
  const owner = capture(runtime);
  if (record.cwd !== owner.cwd) throw new Error(t("task.transcript_owner_changed"));
  const storage = actionScope(runtime);
  const page = await readHistoryPage(owner.client, owner.threadId);
  owner.check();
  if (page.thread?.id !== owner.threadId || page.thread.cwd !== owner.cwd || page.thread.status !== "idle" || runtime.snapshot.running ||
      page.messages.some(message => message.id === record.sourceMessageId)) throw new Error(t("task.transcript_changed"));
  // A successful rewind is explicit deletion authority. Do not merge its removed optimistic tail back in.
  runtime.flushPendingDeltas();
  runtime.patch({ messages: page.messages, hasMoreBefore: page.hasMoreBefore, beforeCursor: page.beforeCursor,
    transcriptSnapshotV1: page.transcriptSnapshotV1, transcriptObservationV1: page.transcriptObservationV1,
    activeTurnId: null, loadingOlder: false, error: null });
  runtime.confirmedTranscriptPage = { page: page.sourcePage, confirmedAt: Date.now() };
  runtime.completedTranscriptRevision++;
  const params = editedParams(runtime, record);
  const dispatched: TranscriptActionRecord = { ...record, phase: "sendSent" };
  await storage.write(record, dispatched); owner.check();
  runtime.transcriptActionSendId = record.id;
  const optimisticId = `local-${record.id}`;
  runtime.patch({ messages: [...runtime.snapshot.messages, { id: optimisticId, role: "user", content: record.text,
    clientMessageId: record.id, timestampMs: Date.now(), attachments }], running: true });
  try {
    await runtime.startOrdinaryTurn(params, optimisticId);
    if (runtime.snapshot.sendAcceptanceUnknown) return;
    await storage.write(dispatched, undefined);
  } catch (error) {
    if (runtime.snapshot.sendAcceptanceUnknown) return;
    const definite = error instanceof MobileRpcError && (error.reason === "remote" || error.delivery === "not-sent");
    if (definite) await storage.write(dispatched, { ...dispatched, phase: "sendRejected" });
    if (!runtime.disposed) runtime.patch({ running: false, messages: runtime.snapshot.messages.filter(message => message.id !== optimisticId) });
    throw error;
  } finally { runtime.transcriptActionSendId = undefined; }
}

export async function forkCompletedTurn(this: TaskRuntime, messageId: string): Promise<string> {
  const message = this.snapshot.messages.find(message => message.id === messageId);
  if (!canChangeTranscript(this.snapshot) || !message || !completedForkMessage(message)) throw new Error(t("task.transcript_changed"));
  const owner = capture(this);
  const storage = actionScope(this);
  const registration = taskRuntimeRegistry.reserveCreation();
  this.patch({ transcriptActionPending: true, loadingOlder: false });
  let record: TranscriptActionRecord = { ...newRecord("fork", message, "", owner.cwd), model: this.snapshot.model, reasoningEffort: this.snapshot.reasoningEffort };
  let saved = false;
  try {
    if (await storage.read()) throw new Error(t("task.transcript_action_unsettled"));
    owner.check();
    await storage.write(undefined, record); saved = true; owner.check();
    const dispatched: TranscriptActionRecord = { ...record, phase: "forkSent" };
    await storage.write(record, dispatched); record = dispatched; owner.check();
    const result = await owner.client.request<{ thread: { id: string; cwd: string }; ephemeral?: boolean }>("thread/fork", {
      threadId: owner.threadId, lastTurnId: message.turnId, cwd: owner.cwd, excludeTurns: true, ephemeral: false,
    });
    // A durable fork owns no source-client lease; the destination resumes independently.
    if (!result.thread?.id || result.thread.id === owner.threadId || result.thread.cwd !== owner.cwd || result.ephemeral === true)
      throw new Error(t("task.transcript_fork_unconfirmed"));
    const forked: TranscriptActionRecord = { ...record, phase: "forked", childThreadId: result.thread.id };
    await storage.write(record, forked);
    record = forked;
    owner.check();
    await prepareForkRuntime(this, forked, registration);
    return result.thread.id;
  } catch (error) {
    if (saved && record.phase === "prepared") await storage.write(record, undefined);
    else if (saved && record.phase === "forkSent" && error instanceof MobileRpcError && (error.reason === "remote" || error.delivery === "not-sent"))
      await storage.write(record, undefined);
    throw error;
  } finally {
    registration.release();
    if (!this.disposed) this.patch({ transcriptActionPending: Boolean(await storage.read()) });
  }
}

/** Recovery reads receipts; it never sends a second rollback, fork, or uncertain turn/start. */
export async function recoverTranscriptAction(this: TaskRuntime): Promise<string | undefined> {
  const storage = actionScope(this);
  const record = await storage.read();
  if (!record) { this.patch({ transcriptActionPending: false }); return; }
  if (record.cwd !== this.snapshot.cwd) throw new Error(t("task.transcript_owner_changed"));
  if (record.phase === "forkReady") return record.childThreadId;
  if (record.phase === "forked") {
    const registration = taskRuntimeRegistry.reserveCreation();
    try { await prepareForkRuntime(this, record, registration); return record.childThreadId; }
    finally { registration.release(); }
  }
  if (record.phase === "rolledBack" || record.phase === "sendRejected") {
    await sendEdited(this, record);
  } else if (record.phase === "sendSent") {
    const owner = capture(this);
    const receipt = await readTurnReceipt(owner.client, editedParams(this, record));
    owner.check();
    await this.acceptOrdinaryResult(receipt, owner.client, true, undefined, owner.current);
    await storage.write(record, undefined);
  } else {
    await refreshActionHistory(this);
    throw new Error(t("task.transcript_result_unknown"));
  }
  this.patch({ transcriptActionPending: Boolean(await storage.read()) });
}

/** Explicit acknowledgement after inspecting authoritative history/files, never an automatic retry. */
export async function dismissTranscriptAction(this: TaskRuntime): Promise<void> {
  const storage = actionScope(this);
  const record = await storage.read();
  if (!record) return;
  if (record.phase !== "forked" && record.phase !== "forkReady") {
    if (this.snapshot.running) throw new Error(t("task.transcript_changed"));
    await refreshActionHistory(this, true);
  }
  await storage.write(record, undefined);
  this.patch({ transcriptActionPending: false });
}

async function prepareForkRuntime(source: TaskRuntime, record: TranscriptActionRecord, registration: TaskCreationRegistration): Promise<void> {
  const owner = capture(source);
  const context = source.reconnectContext!;
  if (!record.childThreadId || record.cwd !== owner.cwd) throw new Error(t("task.transcript_owner_changed"));
  const existing = taskRuntimeRegistry.getForTarget(context.profile, context.server, record.childThreadId, owner.cwd);
  const child = existing ?? await source.resumeForkThread({ ...context, threadId: record.childThreadId, cwd: owner.cwd,
    reasoningEffort: record.reasoningEffort });
  let registered = Boolean(existing);
  try {
    owner.check();
    if (record.model) await child.setTurnPreferences(record.model, record.reasoningEffort);
    owner.check();
    await saveWorkspaceState(context.profile.id, context.server.id, record.childThreadId,
      { model: record.model, reasoningEffort: record.reasoningEffort }, workspaceStateAuthorizationScope(context.profile, context.server),
      captureWorkspaceProfileIdentity(context.profile));
    owner.check();
    if (!existing) { registration.put(context.profile.id, context.server.id, child, () => {}); registered = true; }
    await actionScope(source).write(record, { ...record, phase: "forkReady" });
  } finally { if (!registered) child.close(); }
}

async function refreshActionHistory(runtime: TaskRuntime, requireIdle = false): Promise<void> {
  const owner = capture(runtime);
  const page = await readHistoryPage(owner.client, owner.threadId);
  owner.check();
  if (page.thread?.id !== owner.threadId || page.thread.cwd !== owner.cwd ||
      (requireIdle && (page.thread.status !== "idle" || runtime.snapshot.running))) throw new Error(t("task.transcript_changed"));
  runtime.transcriptMutationRevision++;
  runtime.patch({ messages: page.messages, hasMoreBefore: page.hasMoreBefore, beforeCursor: page.beforeCursor, loadingOlder: false,
    transcriptSnapshotV1: page.transcriptSnapshotV1, transcriptObservationV1: page.transcriptObservationV1 });
  runtime.confirmedTranscriptPage = { page: page.sourcePage, confirmedAt: Date.now() };
}
