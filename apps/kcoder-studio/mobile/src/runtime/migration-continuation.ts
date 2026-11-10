import type { HistoricalContinuationOptions, HistoricalContextPolicy } from "../../../shared/generated/contracts";
import { Sha256Stream } from "@/protocol/sha256-stream";
import { migrationError, type MobileMigrationClient } from "./migration-client";
import { attachmentSelectionIdentity, samePublicValue } from "./migration-client/history-validation";

export const MIGRATION_CONTEXT_POLICY: HistoricalContextPolicy = { maxContextBytes: 4 * 1024 * 1024, maxEntries: 2048, maxAttachments: 256, maxAttachmentBytes: 512 * 1024 * 1024 };
function family(sourceJobId: string, viewId: string, options: HistoricalContinuationOptions, policy: HistoricalContextPolicy) {
  const normalized = [sourceJobId, viewId, options.studioWorkMode, options.model ?? null, options.settingsTemplate ?? null, (options.localAttachments ?? []).map(value => [value.operationId, attachmentSelectionIdentity(value.selection), value.receipt.attachmentId, value.receipt.bytes, value.receipt.chunkBytes, value.receipt.sha256]), policy.maxContextBytes, policy.maxEntries, policy.maxAttachments, policy.maxAttachmentBytes];
  return new Sha256Stream().update(new TextEncoder().encode(JSON.stringify(normalized))).digestHex();
}
/** Persist and atomically claim the original creation identity before crossing the target boundary. */
export async function createOrReconcileContinuation(client: MobileMigrationClient, sourceJobId: string, viewId: string, options: HistoricalContinuationOptions, policy = MIGRATION_CONTEXT_POLICY) {
  for (const binding of options.localAttachments ?? []) {
    if (binding.selection.jobId !== sourceJobId || binding.selection.viewId !== viewId) throw new Error("continuation_attachment_selection_changed");
    const fresh = await client.call("localRead", { operationId: binding.operationId });
    if (attachmentSelectionIdentity(fresh.upload.selection) !== attachmentSelectionIdentity(binding.selection) || fresh.upload.localJob?.historicalContentVerified !== false || fresh.upload.localJob.state.stage !== "ready" || !samePublicValue(fresh.upload.localJob.state.receipt, binding.receipt)) throw new Error("continuation_attachment_receipt_changed");
  }
  const digest = family(sourceJobId, viewId, options, policy), reservation = await client.continuationIntent(sourceJobId, viewId, digest);
  const requestId = reservation.intent.requestId!;
  if (!reservation.created) {
    try {
      const found = await client.call("continuationRead", { jobId: requestId });
      if (family(found.job.sourceJobId, found.job.viewId, found.job.options, found.job.policy) !== digest) throw new Error("migration_invalid_response");
      return found;
    }
    catch (error) {
      if (migrationError(error) !== "continuation_job_not_found" || reservation.intent.phase === "acknowledged") throw error;
      // An authoritative absence allows the same idempotent request; a new identity is never substituted.
    }
  }
  return client.call("continuationCreate", { requestId, sourceJobId, viewId, options, policy }, { familyDigest: digest });
}
