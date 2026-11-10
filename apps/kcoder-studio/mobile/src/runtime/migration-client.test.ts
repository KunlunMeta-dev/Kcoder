import { describe, expect, it, vi } from "vitest";
import { MobileMigrationClient, migrationRequestId } from "./migration-client";
import type { MigrationIntent, MigrationIntentStore } from "@/storage/migration-intents";
const caps = { migrationProvidersV1: true, migrationBatchV1: true, migrationBatchWorkersV1: true, migrationHistoryJobsV1: true, migrationLocalPluginsV1: true, migrationBatchPluginsV1: true, migrationBatchCredentialsV1: true, migrationBatchMcpCredentialsV1: true, migrationReuseV1: true };
const job = (id = "mig-owned", sequence = 2) => ({ job: { jobId: id, sourceId: "source", status: "ready", sequence, totalItems: 1, committedItems: 0, requiresActionItems: 0 }, source: "claude-code", plans: [], issues: [], batch: { planId: "plan-owned", selectedItems: 1, totalActions: 1, committedActions: 0, unresolvedActions: 0 } });
const state = (id = "mig-owned") => ({ state: job(id), workerRunning: false, workerError: null, progress: null });
const plugin = (id: string) => ({ job: { operationId: id, sequence: 0, source: "claude-code", name: "office", scope: "user", stage: "prepared", capabilities: [], readiness: [], pending: [], imported: false, cancelRequested: false, cancelRevision: 0 }, workerRunning: false, workerError: null });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function journal(): MigrationIntentStore & { rows: MigrationIntent[] } {
  const value = { rows: [] as MigrationIntent[], async read() { return [...this.rows]; }, async put(row: MigrationIntent) { const index = this.rows.findIndex(item => item.id === row.id); if (index < 0) this.rows.push(row); else this.rows[index] = row; } };
  return value;
}
describe("Mobile Native migration client", () => {
  it("persists the original public operation identity before sending and records the authoritative acknowledgement", async () => {
    const saved = journal();
    const requestId = migrationRequestId();
    const request = vi.fn(async () => { expect(saved.rows).toHaveLength(1); expect(saved.rows[0]).toMatchObject({ requestId, phase: "intent", method: "migration/plugin/plan" }); return plugin(requestId); });
    const client = new MobileMigrationClient(request, caps, saved, () => true);
    await client.call("pluginPlan", { requestId, candidateId: "ephemeral-owned-grant" });
    expect(saved.rows[0]).toMatchObject({ operationId: requestId, phase: "acknowledged" });
    expect(JSON.stringify(saved.rows)).not.toContain("ephemeral-owned-grant");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("a lost run receipt keeps the same request and only a deliberate read reconciles it; it never retries a mutation", async () => {
    const saved = journal(), id = migrationRequestId();
    const request = vi.fn(async (method: string) => { if (method === "migration/batch/run") throw new Error("connection lost PRIVATE_SECRET"); return state(); });
    const client = new MobileMigrationClient(request, caps, saved, () => true);
    await expect(client.call("batchRun", { jobId: "mig-owned", expectedSequence: 2, planId: "plan-owned", requestId: id, mode: "apply" })).rejects.toMatchObject({ code: "migration_request_failed" });
    expect(saved.rows[0]).toMatchObject({ requestId: id, phase: "unknown", jobId: "mig-owned" });
    expect(request).toHaveBeenCalledTimes(1);
    await client.call("batchRead", { jobId: "mig-owned" });
    expect(request.mock.calls.map(row => row[0])).toEqual(["migration/batch/run", "migration/batch/read"]);
    expect(JSON.stringify(saved.rows)).not.toContain("PRIVATE_SECRET");
  });
  it("scope changes during local intent persistence prevent dispatch, and late replies cannot cross account/target ownership", async () => {
    let current = true;
    const pending = deferred<void>(), saved = journal();
    const write = saved.put.bind(saved);
    saved.put = async value => { await write(value); await pending.promise; };
    const request = vi.fn(async () => state());
    const client = new MobileMigrationClient(request, caps, saved, () => current);
    const result = client.call("cancel", { jobId: "mig-owned", expectedSequence: 2 });
    current = false; pending.resolve();
    await expect(result).rejects.toMatchObject({ code: "migration_scope_changed" });
    expect(request).not.toHaveBeenCalled();
    const late = deferred<unknown>(); current = true;
    const other = new MobileMigrationClient(() => late.promise, caps, journal(), () => current);
    const read = other.call("batchRead", { jobId: "mig-owned" });
    current = false; late.resolve(state());
    await expect(read).rejects.toMatchObject({ code: "migration_scope_changed" });
  });
  it("checks independent plugin/history/batch capability gates and path-free typed schemas before dispatch", async () => {
    const request = vi.fn(async () => plugin("same"));
    const client = new MobileMigrationClient(request, { migrationLocalPluginsV1: true }, journal(), () => true);
    await client.call("pluginRead", { operationId: "same" });
    await expect(client.call("scan", { sourceIds: [] })).rejects.toMatchObject({ code: "migration_update_required" });
    await expect(client.call("pluginPlan", { requestId: "same", candidateId: "grant", sourcePath: "PRIVATE_SOURCE" } as never)).rejects.toMatchObject({ code: "migration_invalid_parameters" });
    expect(request).toHaveBeenCalledTimes(1);
    const old = new MobileMigrationClient(request, { migrationBatchV1: true }, journal(), () => true);
    await expect(old.call("scan", { sourceIds: [], pluginSources: [{ operationId: "same", expectedSequence: 0 }] })).rejects.toMatchObject({ code: "migration_plugins_update_required" });
    await expect(old.call("scan", { sourceIds: [], historySources: [{ catalogId: "catalog", sourceHandle: "handle" }] })).rejects.toMatchObject({ code: "migration_update_required" });
  });
  it("does not permit secret values as credential choices, or silently broaden a selected credential source", async () => {
    const request = vi.fn(async () => job());
    const client = new MobileMigrationClient(request, caps, journal(), () => true);
    const params = { jobId: "mig-owned", expectedSequence: 2, choices: [{ kind: "history" as const, itemId: "h" }], includeDefaultItems: false, excludedItemIds: [], reuseExisting: false };
    await expect(client.call("plan", { ...params, credentials: [{ itemId: "provider", source: "configuration", consentApiKey: true, apiKey: "PRIVATE_SECRET" }] } as never)).rejects.toMatchObject({ code: "migration_invalid_parameters" });
    const old = new MobileMigrationClient(request, { migrationBatchV1: true, migrationBatchWorkersV1: true }, journal(), () => true);
    await expect(old.call("plan", { ...params, credentials: [{ itemId: "provider", source: "environment", consentApiKey: true }] })).rejects.toMatchObject({ code: "migration_credentials_update_required" });
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects mismatched receipts, oversized pages and stalled cursors instead of displaying unrelated or unbounded content", async () => {
    for (const response of [state("other-account-job"), { ...state(), privateField: "PRIVATE_SECRET" }]) {
      const client = new MobileMigrationClient(async () => response, caps, journal(), () => true);
      await expect(client.call("batchRead", { jobId: "mig-owned" })).rejects.toMatchObject({ code: "migration_invalid_response" });
    }
    const candidate = { candidateId: "grant", name: "office", scope: "user", source: "claude-code", pending: [] };
    const tooMany = new MobileMigrationClient(async () => ({ candidates: Array(11).fill(candidate), nextCursor: null, problems: [] }), caps, journal(), () => true);
    await expect(tooMany.call("pluginDiscover", {})).rejects.toMatchObject({ code: "migration_invalid_response" });
    const stalled = new MobileMigrationClient(async () => ({ items: [], nextCursor: "same" }), caps, journal(), () => true);
    await expect(stalled.call("pluginList", { cursor: "same" })).rejects.toMatchObject({ code: "migration_invalid_response" });
  });
  it("a duplicate mutation stays locked until its original receipt settles, while read and explicit cancel remain separate", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(async (method: string) => method === "migration/batch/run" ? pending.promise : method === "migration/cancel" ? job() : state());
    const client = new MobileMigrationClient(request, caps, journal(), () => true);
    const params = { jobId: "mig-owned", expectedSequence: 2, planId: "plan-owned", requestId: migrationRequestId(), mode: "apply" as const };
    const first = client.call("batchRun", params);
    await expect(client.call("batchRun", params)).rejects.toMatchObject({ code: "migration_operation_pending" });
    await client.call("batchRead", { jobId: "mig-owned" });
    await client.call("cancel", { jobId: "mig-owned", expectedSequence: 2 });
    pending.resolve(state()); await first;
    expect(request.mock.calls.filter(call => call[0] === "migration/batch/run")).toHaveLength(1);
  });
  it("closing a page never sends target cancellation and leaves unknown in-flight work recoverable", async () => {
    const pending = deferred<unknown>(), saved = journal();
    const request = vi.fn(() => pending.promise);
    const client = new MobileMigrationClient(request, caps, saved, () => true);
    const result = client.call("pluginCapture", { operationId: "owned", expectedSequence: 2 });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    client.close(); pending.resolve(plugin("owned"));
    await expect(result).rejects.toMatchObject({ code: "migration_scope_changed" });
    expect(saved.rows[0].phase).toBe("unknown");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("gates old-target template and component support without disabling independent history or plugin reads", async () => {
    const request = vi.fn(async () => job());
    const client = new MobileMigrationClient(request, caps, journal(), () => true);
    await expect(client.call("items", { jobId: "mig-owned", includeTemplates: true })).rejects.toMatchObject({ code: "migration_update_required" });
    await expect(client.call("plan", { jobId: "mig-owned", expectedSequence: 2, choices: [{ kind: "mcp", itemId: "mcp", targetName: "selected", cwd: null }], includeDefaultItems: false, excludedItemIds: [], reuseExisting: false })).rejects.toMatchObject({ code: "migration_update_required" });
    expect(request).not.toHaveBeenCalled();
  });
  it("requires explicit local archival consent and never equates reviewing a locator with target success or a replay", async () => {
    const saved = journal(), request = vi.fn(async () => state());
    await saved.put({ id: "original", method: "migration/batch/run", phase: "unknown", createdAt: 1, jobId: "mig-owned", requestId: "same-request" });
    const client = new MobileMigrationClient(request, caps, saved, () => true);
    await expect(client.archiveLocator("original", "no")).rejects.toMatchObject({ code: "migration_explicit_confirmation_required" });
    expect(saved.rows[0].phase).toBe("unknown");
    await client.archiveLocator("original", "ARCHIVE");
    expect(saved.rows[0]).toMatchObject({ phase: "reviewed", requestId: "same-request", jobId: "mig-owned" });
    expect(request).not.toHaveBeenCalled();
  });
  it("reads bounded asset windows under the original item identity and rejects stalled or oversized bodies", async () => {
    for (const result of [{ itemId: "other", text: "wrong", totalBytes: 5, nextOffset: null }, { itemId: "owned", text: "x".repeat(65537), totalBytes: 65537, nextOffset: null }, { itemId: "owned", text: "same", totalBytes: 100, nextOffset: 4 }]) {
      const client = new MobileMigrationClient(async () => result, { migrationAssetsV1: true }, journal(), () => true);
      await expect(client.call("assetPreview", { jobId: "mig-owned", itemId: "owned", offset: 4 })).rejects.toMatchObject({ code: "migration_invalid_response" });
    }
  });
  it("refreshes the cancellation watermark after confirmation and preserves the Native running/cancel-requested distinction", async () => {
    let reads = 0;
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "migration/cancel") { expect(params).toEqual({ jobId: "mig-owned", expectedSequence: 9 }); return { ...job(), job: { ...job().job, sequence: 10, status: "cancel_requested" } }; }
      reads++;
      return { ...state(), state: { ...job(), job: { ...job().job, sequence: reads === 1 ? 9 : 10, status: reads === 1 ? "applying" : "cancel_requested" } }, workerRunning: true };
    });
    const client = new MobileMigrationClient(request, caps, journal(), () => true);
    const result = await client.operateBatch("mig-owned", "plan-owned", "cancel", migrationRequestId());
    expect(result.state.job.status).toBe("cancel_requested"); expect(result.workerRunning).toBe(true);
    expect(request.mock.calls.map(row => row[0])).toEqual(["migration/batch/read", "migration/cancel", "migration/batch/read"]);
  });
  it("a changed frozen plan or an already running worker cannot be silently adopted by a confirmed mutation", async () => {
    for (const response of [{ ...state(), workerRunning: true }, { ...state(), state: { ...job(), batch: { ...job().batch, planId: "other-plan" } } }]) {
      const request = vi.fn(async () => response), saved = journal();
      const client = new MobileMigrationClient(request, caps, saved, () => true);
      await expect(client.operateBatch("mig-owned", "plan-owned", "resume", migrationRequestId())).rejects.toBeInstanceOf(Error);
      expect(request).toHaveBeenCalledTimes(1); expect(saved.rows).toEqual([]);
    }
  });
  it("a plugin captured by a batch while its confirmation is open stays under that original parent", async () => {
    const request = vi.fn(async (_method: string) => ({ ...plugin("same"), job: { ...plugin("same").job, batchJobId: "original-parent", sequence: 5 } }));
    const client = new MobileMigrationClient(request, caps, journal(), () => true);
    await expect(client.operatePlugin("same", "pluginCancel")).rejects.toMatchObject({ code: "plugin_migration_control_owned_by_batch" });
    expect(request.mock.calls.map(row => row[0])).toEqual(["migration/plugin/read"]);
  });
});
it('project plugin options need the independent capability before any target request', async () => {
  const request = vi.fn();
  const client = new MobileMigrationClient(request, { migrationLocalPluginsV1: true }, journal(), () => true);
  await expect(client.call('pluginDiscover', { sources: ['codex'], includeProject: true })).rejects.toMatchObject({ code: 'migration_plugin_projects_update_required' });
  await expect(client.call('pluginPlan', { requestId: 'same-owned-operation', candidateId: 'opaque', projectMapping: 'current_workspace' })).rejects.toMatchObject({ code: 'migration_plugin_projects_update_required' });
  expect(request).not.toHaveBeenCalled();
});

it('ordinary upload and plugin capabilities cannot authorize uploaded plugin discovery', async () => {
  const request = vi.fn();
  const client = new MobileMigrationClient(request, { migrationLocalPluginsV1: true, migrationSourceUploadedV1: true }, journal(), () => true);
  await expect(client.call('pluginDiscover', { sources: ['codex'], includeUploaded: true })).rejects.toMatchObject({ code: 'migration_plugins_update_required' });
  expect(request).not.toHaveBeenCalled();
});
