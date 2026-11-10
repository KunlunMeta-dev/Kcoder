import type { MigrationIntent } from "@/storage/migration-intents";
import type { MobileMigrationClient } from "./migration-client";

/** Reconcile each original Native family through its own read API, never through batch/run. */
export async function recoverHistoricalLocator(client: MobileMigrationClient, row: MigrationIntent): Promise<{ sourceJobId: string; continuationJobId?: string }> {
  if (!row.method.startsWith("migration/history/")) throw new Error("migration_recovery_record_invalid");
  if (row.method.includes("/upload-collection/")) {
    if (!row.operationId || !row.selection) throw new Error("migration_recovery_record_missing");
    const native = await client.call("uploadCollectionRead", { operationId: row.operationId, selection: row.selection });
    if (native.collection) return { sourceJobId: native.collection.selection.jobId };
    const upload = await client.call("localRead", { operationId: row.operationId });
    return { sourceJobId: upload.upload.selection.jobId };
  }
  if (row.method.includes("/local-attachment/")) {
    const operationId = row.operationId ?? row.requestId;
    if (!operationId) throw new Error("migration_recovery_record_missing");
    const native = await client.call("localRead", { operationId });
    return { sourceJobId: native.upload.selection.jobId };
  }
  let continuationJobId: string | undefined;
  if (row.method.includes("/undo/")) {
    if (row.jobId) continuationJobId = (await client.call("undoRead", { jobId: row.jobId })).job.continuationJobId;
    else if (row.continuationJobId) {
      const canonical = await client.call("undoLookup", { continuationJobId: row.continuationJobId });
      if (!canonical.existingJob) throw new Error("historical_undo_job_not_found");
      continuationJobId = canonical.existingJob.continuationJobId;
    }
  } else if (row.method.includes("/continuation/")) continuationJobId = row.jobId ?? row.requestId;
  if (continuationJobId) {
    const native = await client.call("continuationRead", { jobId: continuationJobId });
    return { sourceJobId: native.job.sourceJobId, continuationJobId };
  }
  const jobId = row.jobId ?? row.sourceJobId;
  if (!jobId) throw new Error("migration_recovery_record_missing");
  const native = await client.call("historyRead", { jobId });
  return { sourceJobId: native.job.jobId };
}
