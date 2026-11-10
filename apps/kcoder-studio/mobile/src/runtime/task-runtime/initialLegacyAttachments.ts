import { fromByteArray } from "base64-js";
import { RETAIN_TASK_ATTACHMENTS } from "../../../../shared/attachmentRetention";
import { uploadStagedAttachment } from "@/components/attachment-upload";
import { GatewayRpcClient, MobileRpcError } from "@/gateway/rpc";
import { DraftAttachmentStore } from "@/storage/draft-attachment-store";
import type { AttachmentStoreContext } from "@/storage/staged-attachment-store";
import { hashBoundedSource } from "@/protocol/sha256-stream";
import { t } from "@/i18n";
import type { StagedAttachment, TaskCreationInput } from "./types";

const owners = new WeakMap<GatewayRpcClient, string>();
function connectionOwner(client: GatewayRpcClient): string {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure attachment preparation identity is unavailable");
  let owner = owners.get(client);
  if (!owner) { owner = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, "0")).join(""); owners.set(client, owner); }
  return owner;
}
/** Existing legacy upload and scoped retain contracts, on the caller's one initialized client. */
export async function prepareInitialLegacyAttachments(client: GatewayRpcClient, input: TaskCreationInput, threadId: string, isCurrent: () => boolean): Promise<StagedAttachment[]> {
  const check = () => {
    if (!isCurrent() || !client.matchesRetainedAttachmentOwner(input.profile, input.server, input.cwd)) throw new MobileRpcError("Initial attachment owner changed", -1, "transport", "not-sent");
  };
  check();
  const context: AttachmentStoreContext = { profile: input.profile, server: input.server, workspacePath: input.cwd, isCurrent: () => { check(); return true; } };
  const store = new DraftAttachmentStore(); const owner = connectionOwner(client);
  const selected = await Promise.all(input.localAttachmentIds!.map(id => store.load(context, id)));
  if (selected.some(row => !row || row.draftId !== input.attachmentDraftId)) throw new Error(t("new.draft_original_files_unavailable"));
  const results: StagedAttachment[] = [];
  const needingRetention: string[] = [];
  for (const original of selected) {
    check(); let row = original!;
    if (row.phase === "retained") {
      if (row.threadId !== threadId) throw new Error(t("new.draft_original_files_unavailable"));
    } else {
      if (row.phase !== "prepared" && row.uploadOwner !== owner) {
        if (!input.reprepareInitialAttachments) throw new Error(t("new.draft_upload_unknown"));
        // This explicit action prepares the same local file for the original thread;
        // it never treats an unconfirmed old path as a resource owned by this client.
        row = await store.update(context, row, { phase: "prepared", path: undefined, uploadOwner: undefined }, threadId);
      }
      if (row.phase !== "uploaded") {
        if (row.phase !== "prepared") throw new Error(t("new.draft_upload_unknown"));
        const source = await store.source(context, row);
        if (await hashBoundedSource(source, () => { check(); return true; }) !== row.contentSha256) throw new Error(t("new.draft_original_files_unavailable"));
        row = await store.update(context, row, { phase: "uploading", uploadOwner: owner, threadId });
        let dispatched = false;
        try {
          const path = await uploadStagedAttachment(async (method, params, timeout) => {
            // Cancellation of a known upload is exact cleanup, never new work.
            if (method !== "attachment/upload/cancel") check();
            const alreadyDispatched = dispatched;
            dispatched = true;
            try {
              const reply = await client.request(method, params, timeout);
              if (method !== "attachment/upload/cancel") {
                try { check(); }
                catch (error) {
                  const owned = reply as { path?: unknown; upload_id?: unknown };
                  if (method === "attachment/upload/start" && typeof owned?.upload_id === "string" && owned.upload_id) await client.request("attachment/upload/cancel", { upload_id: owned.upload_id }, 10_000).catch(() => {});
                  if (["attachment/save", "attachment/upload/finish"].includes(method) && typeof owned?.path === "string" && owned.path) await client.request("attachment/delete", { path: owned.path }, 10_000).catch(() => {});
                  throw error;
                }
              }
              return reply;
            } catch (error) {
              if (!alreadyDispatched && error instanceof MobileRpcError && error.delivery === "not-sent") dispatched = false;
              throw error;
            }
          }, row.filename, row.size, async (offset, length) => {
            check(); const bytes = new Uint8Array(length);
            for (let at = 0; at < length; at += 64 * 1024) { check(); bytes.set(await source.read(offset + at, Math.min(64 * 1024, length - at)), at); }
            check(); return fromByteArray(bytes);
          });
          check(); row = await store.update(context, row, { phase: "uploaded", path });
        } catch (error) {
          await store.update({ ...context, isCurrent: () => true }, row, { phase: dispatched ? "unknown" : "prepared", ...(dispatched ? {} : { uploadOwner: undefined }) }).catch(() => {});
          throw error;
        }
      }
      needingRetention.push(row.path!);
    }
    results.push({ filename: row.filename, mimeType: row.mimeType, fileSize: row.size, path: row.path! });
  }
  if (needingRetention.length) {
    check();
    const reply = await client.request<{ retained?: boolean; paths?: string[] }>(RETAIN_TASK_ATTACHMENTS, { threadId, paths: needingRetention });
    check();
    if (reply.retained !== true || !Array.isArray(reply.paths) || JSON.stringify([...reply.paths].sort()) !== JSON.stringify([...needingRetention].sort())) throw new Error(t("new.draft_upload_unknown"));
    for (const id of input.localAttachmentIds!) {
      const row = await store.load(context, id);
      if (!row || row.draftId !== input.attachmentDraftId) throw new Error(t("new.draft_original_files_unavailable"));
      if (row.phase !== "retained") await store.update(context, row, { phase: "retained", threadId });
    }
  }
  return results;
}

/** Only an accepted original first turn permits removing these exact local sources. */
export async function completeInitialLegacyAttachments(input: TaskCreationInput, threadId: string): Promise<void> {
  if (input.attachmentTransport !== "legacy") return;
  const context = { profile: input.profile, server: input.server, workspacePath: input.cwd, isCurrent: () => true };
  const store = new DraftAttachmentStore();
  for (const id of input.localAttachmentIds ?? []) {
    const row = await store.load(context, id);
    if (!row) continue;
    if (row.draftId !== input.attachmentDraftId || row.phase !== "retained" || row.threadId !== threadId) throw new Error(t("new.draft_original_files_unavailable"));
    await store.discardSource(context, row, true);
  }
}
