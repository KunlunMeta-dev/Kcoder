import { expect, it, vi } from "vitest";
import { MobileMigrationClient } from "./migration-client";
import { CALLS } from "./migration-client/contracts";
import { createOrReconcileContinuation, MIGRATION_CONTEXT_POLICY } from "./migration-continuation";
import type { MigrationIntent, MigrationIntentStore } from "@/storage/migration-intents";
const caps = { migrationHistoryJobsV1: true, migrationHistoryBranchesV1: true, migrationBranchToolsV1: true, migrationHistoryAttachmentsV1: true, migrationHistoryToolAttachmentsV1: true, migrationLocalAttachmentsV1: true, migrationContinuationV1: true, migrationContinuationUndoV1: true };
function journal() {
  const rows: MigrationIntent[] = [];
  const saved: MigrationIntentStore = { read: async () => [...rows], put: async row => { const index = rows.findIndex(value => value.id === row.id); if (index < 0) rows.push(row); else rows[index] = row; }, reserveFamily: async candidate => { const found = rows.find(row => row.familyDigest === candidate.familyDigest); if (found) return found; rows.push(candidate); return candidate; } };
  return { rows, saved };
}
const continuation = (jobId: string) => ({ job: { jobId, sourceJobId: "history", viewId: "view", sequence: 0, stage: "planned", cancelRequested: false, cancelRevision: 0, policy: MIGRATION_CONTEXT_POLICY, options: { studioWorkMode: "kcoder" }, processedBytes: 0 }, workerRunning: false });
it("independently gates every historical capability and never silently routes one family to another", async () => {
  const request = vi.fn(async () => ({ choice: null, progress: null, workerRunning: false }));
  const client = new MobileMigrationClient(request, { migrationHistoryJobsV1: true }, journal().saved, () => true);
  for (const [name, rule] of Object.entries(CALLS)) if (name.startsWith("branch") || name.startsWith("tools") || name.startsWith("local") || name.startsWith("undo")) expect(client.supports(name as keyof typeof CALLS)).toBe(false);
  await expect(client.call("branchRead", { jobId: "history" })).rejects.toMatchObject({ code: "migration_update_required" }); expect(request).not.toHaveBeenCalled();
});
it("rejects wrong view IDs and eleven links even when the JSON shape itself is valid", async () => {
  for (const response of [{ state: { viewId: "different", workerRunning: false, cancelRequested: false } }, { state: { viewId: "view", workerRunning: false, cancelRequested: false }, extraPrivate: "SECRET" }]) {
    const client = new MobileMigrationClient(async () => response, caps, journal().saved, () => true);
    await expect(client.call("toolsRead", { jobId: "history", viewId: "view" })).rejects.toMatchObject({ code: "migration_invalid_response" });
  }
  const link = { callId: "call", id: "link", outcome: "outcome_unknown", status: "missing_result" }, progress = { processedRecords: 1, recordedLinks: 11, sealed: true, unresolvedLinks: 11 };
  const client = new MobileMigrationClient(async () => ({ links: Array(11).fill(link), progress }), caps, journal().saved, () => true);
  await expect(client.call("toolsPage", { jobId: "history", viewId: "view" })).rejects.toMatchObject({ code: "migration_invalid_response" });
});
it("does not accept historical equivalence or different local selections in a valid-shaped local result", async () => {
  const selection = { jobId: "history", viewId: "view", position: 0, blockIndex: 0 };
  for (const replacement of [{ selection: { ...selection, jobId: "other" } }, { localJob: { selection, historicalContentVerified: true, info: { kind: "local_reference" }, state: { operationId: "op", sequence: 1, stage: "ready", cancelRequested: false, cancelRevision: 0, processedBytes: 0 } } }]) {
    const upload = { operationId: "op", selection, sequence: 0, stage: "prepared", cancelRequested: false, cancelRevision: 0, partBytes: 196608, receivedBytes: 0, receivedParts: 0, ...replacement };
    const client = new MobileMigrationClient(async () => ({ upload, workerRunning: false }), caps, journal().saved, () => true);
    await expect(client.call("localPrepare", { requestId: "op", selection })).rejects.toMatchObject({ code: "migration_invalid_response" });
  }
});
it("claims the original creation identity before dispatch, and a lost reply reconciles by reading the same job without replay", async () => {
  const saved = journal(); let operationId = "";
  const request = vi.fn(async (method: string, params: any) => {
    if (method.endsWith("/create")) { operationId = params.requestId; expect(saved.rows[0]).toMatchObject({ jobId: operationId, phase: "intent", sourceJobId: "history", viewId: "view" }); throw new Error("lost PRIVATE_SECRET"); }
    return continuation(operationId);
  });
  const first = new MobileMigrationClient(request, caps, saved.saved, () => true);
  await expect(createOrReconcileContinuation(first, "history", "view", { studioWorkMode: "kcoder" })).rejects.toMatchObject({ code: "migration_request_failed" });
  expect(saved.rows).toHaveLength(1); expect(saved.rows[0].phase).toBe("unknown"); expect(JSON.stringify(saved.rows)).not.toContain("PRIVATE_SECRET"); first.close();
  const reopened = new MobileMigrationClient(request, caps, saved.saved, () => true);
  expect((await createOrReconcileContinuation(reopened, "history", "view", { studioWorkMode: "kcoder" })).job.jobId).toBe(operationId);
  expect(request.mock.calls.map(row => row[0])).toEqual(["migration/history/continuation/create", "migration/history/continuation/read"]);
});
it("keeps changed model or binding families separate, preserves the 2048-entry gate and rejects unused/crossview supplements", async () => {
  const saved = journal(), ids: string[] = [];
  const request = vi.fn(async (_method: string, params: any) => { ids.push(params.requestId); return { ...continuation(params.requestId), job: { ...continuation(params.requestId).job, options: params.options, policy: params.policy } }; });
  const client = new MobileMigrationClient(request, caps, saved.saved, () => true);
  await createOrReconcileContinuation(client, "history", "view", { studioWorkMode: "kcoder" });
  await createOrReconcileContinuation(client, "history", "view", { studioWorkMode: "kcoder", model: "explicit-model" });
  expect(ids[0]).not.toBe(ids[1]); expect(request.mock.calls[0][1].policy.maxEntries).toBe(2048);
  await expect(createOrReconcileContinuation(client, "history", "view", { studioWorkMode: "kcoder", localAttachments: [{ operationId: "op", selection: { jobId: "history", viewId: "different", position: 0, blockIndex: 0 }, receipt: { attachmentId: "a", bytes: 0, chunkBytes: 1, sha256: "0".repeat(64) } }] })).rejects.toThrow("continuation_attachment_selection_changed");
  expect(request).toHaveBeenCalledTimes(2);
});
it("does not send readable reconstruction to targets without its capability", async () => {
  const request = vi.fn(async () => ({ choice: null, progress: null, workerRunning: false }));
  const client = new MobileMigrationClient(request, caps, journal().saved, () => true);
  await expect(client.call("branchPrepare", { jobId: "history", relatedJobIds: [], reconstructReadable: true })).rejects.toMatchObject({ code: "migration_history_reconstruction_update_required" });
  expect(request).not.toHaveBeenCalled();
});
