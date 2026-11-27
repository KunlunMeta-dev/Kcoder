import type { AttachmentDraftRetainResult } from "./generated/contracts";

/** Gateway broker operations; these methods are never forwarded to app-server. */
export const RETAIN_TASK_ATTACHMENTS = "gateway/attachments/retain";
export const DISCARD_RETAINED_TASK_ATTACHMENTS = "gateway/attachments/discardRetained";
export const DURABLE_DRAFT_CAPABILITY = "durableAttachmentDraftsV1";
export interface RetainTaskAttachmentsParams {
  /** An exact authenticated binding may reclaim an unowned staged upload after reconnect. */
  threadId: string;
  paths: string[];
  /** Persist bytes and authority at the target; require the negotiated capability. */
  durable?: boolean;
}
export type DurableTaskAttachmentsResult = AttachmentDraftRetainResult & { retained: true; paths: string[] };
export interface DiscardRetainedTaskAttachmentsParams {
  threadId: string;
  paths: string[];
}
/** Each path requires exact binding and authoritative thread absence. */
export interface DiscardRetainedTaskAttachmentsResult {
  cleared: string[];
  pending: string[];
}
