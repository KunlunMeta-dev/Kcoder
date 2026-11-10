import { expect, it, vi } from "vitest";
import { MobileMigrationClient } from "./migration-client";
const caps = { migrationHistorySearchV1: true, migrationHistoryReadV1: true, migrationHistoryBranchesV1: true };
const hit = { position: 4, record: 15, role: "user", block: { index: 2, kind: "text", bodyAvailable: true, sourceBytes: 100 }, before: "before ", matched: "Needle", after: " after", bodyCursor: "connection-signed-body" };
const page = { items: [hit], scannedRecords: 8, totalRecords: 12, processedBytes: 1024, unsupportedBlocks: 1, excludedBlocks: 2, nextCursor: "connection-signed-next" };
const text = { encoding: "json_string", text: "Inert <script>source only</script>", sourceBytes: 100, decodedBytes: 90, nextCursor: null };
function make(request: (method: string, params: any) => Promise<unknown>, capabilities = caps, current = () => true) {
  const journal = { read: vi.fn(async () => []), put: vi.fn(async () => {}) };
  return { client: new MobileMigrationClient(request, capabilities, journal, current), journal };
}
it("uses independent search and body-read capabilities and sends no mutation or local journal write", async () => {
  const request = vi.fn(async () => page), value = make(request, { migrationHistorySearchV1: true } as typeof caps);
  expect((await value.client.call("historySearch", { jobId: "archive", query: "Needle", limit: 10 })).items).toHaveLength(1);
  await expect(value.client.call("archiveText", { jobId: "archive", record: 15, blockIndex: 2, cursor: hit.bodyCursor })).rejects.toMatchObject({ code: "migration_update_required" });
  expect(request).toHaveBeenCalledTimes(1); expect(value.journal.read).not.toHaveBeenCalled(); expect(value.journal.put).not.toHaveBeenCalled();
});
it("retains the exact submitted query/case/branch and body coordinates, forwarding opaque signed cursors only to the same Native reader", async () => {
  const request = vi.fn(async (method: string) => method.endsWith("/search") ? page : text), value = make(request);
  const query = " Needle ";
  const found = await value.client.call("historySearch", { jobId: "archive", viewId: "branch-view", query, caseSensitive: true, limit: 10 });
  await value.client.call("branchText", { jobId: "archive", viewId: "branch-view", position: found.items[0]!.position, blockIndex: found.items[0]!.block.index, cursor: found.items[0]!.bodyCursor });
  expect(request.mock.calls).toEqual([["migration/history/search", { jobId: "archive", viewId: "branch-view", query, caseSensitive: true, limit: 10 }], ["migration/history/branch/text", { jobId: "archive", viewId: "branch-view", position: 4, blockIndex: 2, cursor: "connection-signed-body" }]]);
  expect(value.journal.put).not.toHaveBeenCalled();
});
it("raw archive body reads use raw record coordinates rather than the branch position", async () => {
  const request = vi.fn(async () => text), value = make(request);
  await value.client.call("archiveText", { jobId: "archive", record: hit.record, blockIndex: hit.block.index, cursor: hit.bodyCursor });
  expect(request).toHaveBeenCalledWith("migration/history/text", { jobId: "archive", record: 15, blockIndex: 2, cursor: "connection-signed-body" });
  await expect(value.client.call("archiveText", { jobId: "archive", record: 15, blockIndex: 2, offset: 0 } as never)).rejects.toMatchObject({ code: "migration_invalid_parameters" });
});
it("bounds queries and result pages before dispatch and never falls back from search to another tool", async () => {
  const request = vi.fn(async () => page), value = make(request);
  for (const params of [{ query: " " }, { query: "a".repeat(257) }, { query: "emoji", limit: 11 }, { query: "emoji", limit: 0 }]) await expect(value.client.call("historySearch", { jobId: "archive", ...params })).rejects.toMatchObject({ code: "history_search_invalid_query" });
  expect(request).not.toHaveBeenCalled();
  const old = make(request, { migrationHistoryReadV1: true } as typeof caps);
  await expect(old.client.call("historySearch", { jobId: "archive", query: "Needle" })).rejects.toMatchObject({ code: "migration_update_required" }); expect(request).not.toHaveBeenCalled();
});
it("rejects eleven hits, stalled cursors, missing body grants and oversized body windows", async () => {
  for (const result of [{ ...page, items: Array(11).fill(hit) }, { ...page, nextCursor: "same" }, { ...page, items: [{ ...hit, bodyCursor: "" }] }, { ...page, items: [{ ...hit, before: "x".repeat(4097) }] }, { ...page, sourcePath: "/unaccepted/private/path" }]) {
    const value = make(async () => result);
    await expect(value.client.call("historySearch", { jobId: "archive", query: "Needle", cursor: "same" })).rejects.toMatchObject({ code: "migration_invalid_response" });
  }
  const value = make(async () => ({ ...text, text: "x".repeat(65537) }));
  await expect(value.client.call("archiveText", { jobId: "archive", record: 15, blockIndex: 2, cursor: hit.bodyCursor })).rejects.toMatchObject({ code: "migration_invalid_response" });
});
it("a late old account/auth-generation search result cannot cross its original client owner", async () => {
  let resolve!: (value: unknown) => void, current = true;
  const deferred = new Promise<unknown>(yes => { resolve = yes; }), value = make(() => deferred, caps, () => current);
  const pending = value.client.call("historySearch", { jobId: "archive", query: "Needle" }); current = false; resolve(page);
  await expect(pending).rejects.toMatchObject({ code: "migration_scope_changed" }); expect(value.journal.put).not.toHaveBeenCalled();
});
