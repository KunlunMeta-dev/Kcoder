/** Gateway broker operations; these methods are never forwarded to app-server. */
export const RETAIN_TASK_ATTACHMENTS = "gateway/attachments/retain";
export const DISCARD_RETAINED_TASK_ATTACHMENTS = "gateway/attachments/discardRetained";
export interface RetainTaskAttachmentsParams {
  threadId: string;
  paths: string[];
}
export interface DiscardRetainedTaskAttachmentsParams {
  threadId: string;
  paths: string[];
}
/** Each path requires exact binding and authoritative thread absence. */
export interface DiscardRetainedTaskAttachmentsResult {
  cleared: string[];
  pending: string[];
}
