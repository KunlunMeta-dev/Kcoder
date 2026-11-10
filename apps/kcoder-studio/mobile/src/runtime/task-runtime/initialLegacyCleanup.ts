import { clearPendingThreadCreation, loadPendingThreadCreation } from "@/storage/pending-thread-creation";
import type { JsonRecord } from "@/gateway/rpc";
import type { TurnStartResult } from "../../../../shared/turnReceipt";
import { completeInitialLegacyAttachments } from "./initialLegacyAttachments";
import type { TaskRuntime } from "./core";
import type { TaskCreationInput } from "./types";

const cleanups = new WeakMap<TaskRuntime, { input: TaskCreationInput; key: string; requestId: string; threadId: string }>();
/** Keep the original authority on the runtime while its first turn is unknown. */
export function observeInitialLegacyAcceptance(runtime: TaskRuntime, input: TaskCreationInput, key: string, requestId: string): void {
  if (input.attachmentTransport === "legacy" && runtime.getSnapshot().sendAcceptanceUnknown) cleanups.set(runtime, { input, key, requestId, threadId: runtime.getSnapshot().threadId });
}
/** Called only with the exact request and authoritative readTurnReceipt result. */
export async function reconcileInitialLegacyAcceptance(runtime: TaskRuntime, params: JsonRecord, receipt: TurnStartResult): Promise<void> {
  const job = cleanups.get(runtime);
  if (!job || runtime.isDisposed() || runtime.getSnapshot().threadId !== job.threadId || params.threadId !== job.threadId || params.clientMessageId !== `${job.requestId}-initial-turn` || typeof receipt.turn?.id !== "string" || !receipt.turn.id) return;
  const pending = await loadPendingThreadCreation(job.key);
  if (pending?.linked || pending?.clientRequestId !== job.requestId || pending.threadId !== job.threadId || !pending.turnDispatched || pending.initialTurnParams?.clientMessageId !== params.clientMessageId) return;
  await completeInitialLegacyAttachments(job.input, job.threadId);
  await clearPendingThreadCreation(job.key, job.requestId);
  if (cleanups.get(runtime) === job) cleanups.delete(runtime);
}
