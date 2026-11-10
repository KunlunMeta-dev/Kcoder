import { prepareInitialLegacyAttachments } from "./initialLegacyAttachments";
import { legacyAttachmentPrompt } from "@/protocol/attachment-prompt";
import type { GatewayRpcClient, JsonRecord } from "@/gateway/rpc";
import { RETENTION_CAPABILITY } from "@/protocol/attachment-retention";
import { StagedAttachmentStore, type AttachmentStoreContext } from "@/storage/staged-attachment-store";
import { RetainedAttachmentUploader } from "@/storage/retained-attachment-upload";
import { StagedAttachmentConsumers } from "@/storage/staged-attachment-consumers";
import { permissionParams } from "./turns";
import type { TaskCreationInput, StagedAttachment } from "./types";

export function checkInitialTurnCapabilities(client: GatewayRpcClient, input: TaskCreationInput): void {
  permissionParams(input.permissionMode, client);
  if (input.localAttachmentIds?.length && (!client.supportsExperimental("turnReceiptsV1") || !client.supportsExperimental("threadCreationReceiptsV1"))) throw new Error("Target does not support recoverable initial messages");
  if ((input.sessionMode === "orchestrate" || input.turnMode && input.turnMode !== "standard") && !client.supportsExperimental("sessionModes")) throw new Error("目标 KCoder 不支持特殊执行模式，请升级后重试");
  if (input.localAttachmentIds?.length && input.attachmentTransport !== "legacy" && (!client.supportsExperimental(RETENTION_CAPABILITY) || !client.supportsExperimental("turnReceiptsV1") || !client.supportsExperimental("threadCreationReceiptsV1") || !client.getAttachmentUploadAdmission())) {
    throw new Error("Target does not support recoverable initial attachments");
  }
}

/** Upload and reserve only the immutable local selection, after the real thread ID is known. */
export async function prepareInitialTurn(client: GatewayRpcClient, input: TaskCreationInput, threadId: string, clientMessageId: string, model: string | undefined, isCurrent: () => boolean, onLegacyAttachments?: (attachments: StagedAttachment[]) => Promise<void>): Promise<JsonRecord> {
  checkInitialTurnCapabilities(client, input);
  const params: JsonRecord = { threadId, clientMessageId, input: [{ type: "text", text: input.prompt }],
    ...permissionParams(input.permissionMode, client), ...(input.turnMode ? { turnMode: input.turnMode } : {}),
    ...(model ? { model } : {}), ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) };
  const ids = input.localAttachmentIds;
  if (!ids?.length) return params;
  if (input.attachmentTransport === "legacy") {
    const attachments = await prepareInitialLegacyAttachments(client, input, threadId, isCurrent);
    await onLegacyAttachments?.(attachments);
    params.input = [{ type: "text", text: legacyAttachmentPrompt(input.prompt, attachments) }];
    return params;
  }
  const context: AttachmentStoreContext = { profile: input.profile, server: input.server, workspacePath: input.cwd, isCurrent };
  const store = new StagedAttachmentStore();
  const uploader = new RetainedAttachmentUploader(context, client, store);
  let rows = await Promise.all(ids.map(id => store.load(context, id)));
  if (rows.some(row => !row || row.composer?.draftId !== input.attachmentDraftId)) throw new Error("Initial attachment owner changed");
  const existing = rows.find(row => row!.consumers.length)?.consumers[0];
  if (!existing) {
    for (const id of ids) { if (!isCurrent()) throw new Error("Initial attachment owner changed"); await uploader.resume(id); }
    rows = await Promise.all(ids.map(id => store.load(context, id)));
  }
  const consumers = new StagedAttachmentConsumers(context, client, store);
  const handle = existing ? { leaderId: existing.leaderId, reserveId: existing.reserveId, threadId, clientMessageId } : await consumers.prepare(ids, threadId, clientMessageId, input.attachmentDraftId);
  const proof = await consumers.reserveOrRead(handle);
  if (!isCurrent()) throw new Error("Initial attachment owner changed");
  const attachments = proof.stageRefs.map(ref => {
    const row = rows.find(candidate => candidate?.stageRef?.entryId === ref.entryId);
    if (!row?.composer) throw new Error("Initial attachment receipt does not match the selected files");
    return { entryId: ref.entryId, filename: row.filename, mimeType: row.composer.mimeType };
  });
  params.retention = { references: [{ retentionId: proof.retentionId, expectedRevision: proof.expectedRevision, entryIds: proof.entryIds }], attachments };
  // Server-ready scoped receipts, rather than turn acceptance guesses, authorize local byte cleanup.
  await consumers.removeConfirmedSources(proof);
  return params;
}
