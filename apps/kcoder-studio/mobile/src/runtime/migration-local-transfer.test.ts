import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { fromByteArray } from "base64-js";
import type { MobileMigrationClient } from "./migration-client";
import { hashMigrationSource, sendMigrationLocalFile, receiveMigrationAttachment, type MigrationLocalSource } from "./migration-local-transfer";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const selection = { jobId: "source-job", viewId: "branch-view", position: 2, blockIndex: 1 };
function source(bytes = new Uint8Array(400000).fill(97)): MigrationLocalSource & { reads: number[]; closed: number } {
  return { filename: "user-supplied.txt", size: bytes.length, reads: [], closed: 0, async read(offset, count) { this.reads.push(count); return bytes.slice(offset, offset + count); }, close() { this.closed++; } };
}
function receiver(bytes: Uint8Array, options: { lostPart?: boolean; prefix?: number; badCredit?: boolean } = {}) {
  let seq = 1, count = options.prefix ?? 0;
  const partBytes = 192 * 1024;
  const view = () => ({ upload: { operationId: "op", selection, sequence: seq, stage: seq === 1 ? "prepared" : "receiving", partBytes, receivedParts: count, receivedBytes: Math.min(bytes.length, count * partBytes) + (options.badCredit ? 1 : 0), cancelRequested: false, cancelRevision: 0, ...(seq > 1 ? { bytes: bytes.length, filename: "user-supplied.txt", sha256: sha(bytes) } : {}) }, workerRunning: false });
  if (count) seq = 3;
  const call = vi.fn(async (name: string, params: any) => {
    if (name === "localBegin") { expect(params.sha256).toBe(sha(bytes)); seq++; }
    if (name === "localPart") { expect(params.index).toBe(count); expect(params.expectedSequence).toBe(seq); count++; seq++; if (options.lostPart) throw new Error("lost reply"); }
    return view();
  });
  return { client: { call, available: () => true } as unknown as MobileMigrationClient, call };
}
it("hashes a 400000-byte selection without reading the whole file, then sends three bounded parts with Native sequence credit", async () => {
  const bytes = new Uint8Array(400000).fill(97), file = source(bytes), host = receiver(bytes);
  await sendMigrationLocalFile(host.client, "op", file, () => {});
  expect(file.closed).toBe(1); expect(Math.max(...file.reads)).toBeLessThanOrEqual(192 * 1024);
  expect(host.call.mock.calls.filter(row => row[0] === "localPart")).toHaveLength(3);
  expect(host.call.mock.calls.some(row => ["localFinish", "localRun"].includes(row[0]))).toBe(false);
  expect(JSON.stringify(host.call.mock.calls)).not.toContain("sourceUri");
});
it("does not replay a part after losing its receipt, and a new explicit selection resumes from authoritative credit", async () => {
  const bytes = new Uint8Array(400000).fill(97), first = source(bytes), lost = receiver(bytes, { lostPart: true });
  await expect(sendMigrationLocalFile(lost.client, "op", first, () => {})).rejects.toThrow("lost reply");
  expect(lost.call.mock.calls.filter(row => row[0] === "localPart")).toHaveLength(1); expect(first.closed).toBe(1);
  const resumed = receiver(bytes, { prefix: 1 }); await sendMigrationLocalFile(resumed.client, "op", source(bytes), () => {});
  expect(resumed.call.mock.calls.filter(row => row[0] === "localPart").map(row => row[1].index)).toEqual([1, 2]);
});
it("checks cancellation around asynchronous source reads and closes only the selected source", async () => {
  const file = source(), host = receiver(new Uint8Array(400000).fill(97)); let cancelled = false;
  file.read = async (_offset, count) => { cancelled = true; return new Uint8Array(count); };
  await expect(sendMigrationLocalFile(host.client, "op", file, () => { if (cancelled) throw new Error("local_upload_cancel_requested"); })).rejects.toThrow("local_upload_cancel_requested");
  expect(host.call).not.toHaveBeenCalled(); expect(file.closed).toBe(1);
});
it("rejects oversized files before any source read and rejects inconsistent acknowledged receiver credit", async () => {
  const read = vi.fn(); await expect(hashMigrationSource({ size: 256 * 1024 * 1024 + 1, read }, () => {})).rejects.toThrow("local_upload_file_budget_exceeded"); expect(read).not.toHaveBeenCalled();
  const bytes = new Uint8Array(4).fill(97), file = source(bytes), host = receiver(bytes, { badCredit: true });
  await expect(sendMigrationLocalFile(host.client, "op", file, () => {})).rejects.toThrow("migration_invalid_response"); expect(host.call.mock.calls.filter(row => row[0] === "localPart")).toHaveLength(0); expect(file.closed).toBe(1);
});
it("detects a changed handle between hashing and the transmitted read before allowing the caller to seal it", async () => {
  const bytes = new Uint8Array(4).fill(97), file = source(bytes), host = receiver(bytes); let reads = 0;
  file.read = async () => ++reads === 1 ? bytes : new Uint8Array(4).fill(98);
  await expect(sendMigrationLocalFile(host.client, "op", file, () => {})).rejects.toThrow("local_upload_source_changed");
  expect(host.call.mock.calls.some(row => row[0] === "localFinish")).toBe(false); expect(file.closed).toBe(1);
});
it("checks every downloaded chunk and full exact receipt before completing a selected output", async () => {
  const bytes = new Uint8Array(400000).fill(97), receipt = { attachmentId: "historical-attachment", bytes: bytes.length, chunkBytes: 196608, sha256: sha(bytes) };
  const call = vi.fn(async (_name: string, params: any) => { expect(params.expectedReceipt).toEqual(receipt); const part = bytes.slice(params.offset, params.offset + params.limit); return { receipt, offset: params.offset, nextOffset: params.offset + part.length === bytes.length ? null : params.offset + part.length, dataBase64: fromByteArray(part), dataSha256: sha(part) }; });
  const sink = { write: vi.fn(async () => {}), finish: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  await receiveMigrationAttachment({ call, available: () => true } as unknown as MobileMigrationClient, selection, receipt, sink, () => {}, "op");
  expect(call).toHaveBeenCalledTimes(3); expect(sink.finish).toHaveBeenCalledTimes(1); expect(sink.abort).not.toHaveBeenCalled();
});
it("does not deliver corrupted, stalled or substituted attachment bytes", async () => {
  const bytes = new Uint8Array([97, 98]), receipt = { attachmentId: "a", bytes: 2, chunkBytes: 2, sha256: sha(bytes) };
  for (const replacement of [{ dataSha256: "0".repeat(64) }, { receipt: { ...receipt, sha256: "1".repeat(64) } }, { nextOffset: 1 }, { dataBase64: "" }]) {
    const call = vi.fn(async () => ({ receipt, offset: 0, dataBase64: fromByteArray(bytes), dataSha256: sha(bytes), nextOffset: null, ...replacement }));
    const sink = { write: vi.fn(async () => {}), finish: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    await expect(receiveMigrationAttachment({ call, available: () => true } as unknown as MobileMigrationClient, selection, receipt, sink, () => {})).rejects.toThrow();
    expect(sink.finish).not.toHaveBeenCalled(); expect(sink.abort).toHaveBeenCalledTimes(1);
  }
});
