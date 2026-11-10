import { describe, expect, it, vi } from "vitest";
import { MigrationResultsReader } from "./migration-results";
const summary = (id = "job-a") => ({ jobId: id, sourceId: "source", status: "completed", sequence: 2, totalItems: 1, committedItems: 1, requiresActionItems: 0 });
const detail = (id = "job-a") => ({ job: summary(id), source: "claude-code", issues: [], plans: [] });
const record = (id = "job-a") => ({ job: summary(id), source: "claude-code", createdAtMs: 1, isBatch: true, selectedItems: 1 });
const history = (id = "history-a") => ({ job: { jobId: id, sequence: 2, source: "codex", stage: "cancelled", archived: false, cancelRequested: true, failureCode: null }, workerRunning: false, progress: null, workerError: null });
const caps = { migrationProvidersV1: true, migrationBatchV1: true, migrationHistoryJobsV1: true, migrationHistoryReadV1: true, migrationContinuationV1: true };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
describe("Mobile migration read ownership", () => {
    it("only reads target-owned result endpoints and never discovers, creates, resumes or cancels work", async () => {
        const request = vi.fn(async (method: string) => method === "migration/jobs/list" ? { jobs: [record()], nextCursor: "next" } : method === "migration/read" ? detail() : history());
        const reader = new MigrationResultsReader(request, caps);
        await reader.read("jobs", { cursor: null });
        await reader.read("job", { jobId: "job-a" });
        await reader.read("history", { jobId: "history-a" });
        expect(request.mock.calls.map(call => call[0])).toEqual(["migration/jobs/list", "migration/read", "migration/history/read"]);
        await expect(reader.read("create" as never, {} as never)).rejects.toMatchObject({ reason: "unsupported" });
        expect(request).toHaveBeenCalledTimes(3);
        reader.close();
    });
    it("checks independent capabilities before sending, including history on a target with no configuration migration", async () => {
        const request = vi.fn(async () => history());
        const reader = new MigrationResultsReader(request, { migrationHistoryJobsV1: true });
        await expect(reader.read("jobs", {})).rejects.toMatchObject({ reason: "unsupported" });
        expect(request).not.toHaveBeenCalled();
        expect((await reader.read("history", { jobId: "history-a" })).job.stage).toBe("cancelled");
    });
    it("a late result cannot cross target, account or authorization ownership", async () => {
        let current = true;
        const pending = deferred<unknown>();
        const reader = new MigrationResultsReader(() => pending.promise as Promise<never>, caps, () => current);
        const result = reader.read("job", { jobId: "job-a" });
        current = false;
        pending.resolve(detail());
        await expect(result).rejects.toMatchObject({ reason: "expired" });
    });
    it("leaving the page aborts only local reads and tolerates a later remote rejection", async () => {
        const pending = deferred<unknown>();
        const request = vi.fn((_method: string) => pending.promise as Promise<never>);
        const reader = new MigrationResultsReader(request, caps);
        const result = reader.read("job", { jobId: "job-a" });
        reader.close();
        await expect(result).rejects.toMatchObject({ reason: "expired" });
        pending.reject(new Error("late transport close"));
        await Promise.resolve();
        expect(request).toHaveBeenCalledTimes(1);
        await expect(reader.read("job", { jobId: "job-a" })).rejects.toMatchObject({ reason: "expired" });
    });
    it("an abandoned selector does not apply its late result or issue a mutation", async () => {
        const pending = deferred<unknown>();
        const controller = new AbortController();
        const request = vi.fn((_method: string) => pending.promise as Promise<never>);
        const reader = new MigrationResultsReader(request, caps);
        const result = reader.read("history", { jobId: "history-a" }, controller.signal);
        controller.abort();
        await expect(result).rejects.toMatchObject({ reason: "expired" });
        pending.resolve(history());
        await Promise.resolve();
        expect(request.mock.calls.map(call => call[0])).toEqual(["migration/history/read"]);
        const preAborted = new AbortController();
        preAborted.abort();
        await expect(reader.read("jobs", {}, preAborted.signal)).rejects.toMatchObject({ reason: "expired" });
        expect(request).toHaveBeenCalledTimes(1);
    });
});
describe("Mobile migration bounded result pages", () => {
    it("keeps opaque pagination cursors and accepts no more than ten authoritative rows", async () => {
        const request = vi.fn(async (_method: string, params: unknown) => (params as {
            cursor?: string;
        }).cursor === "second" ? { jobs: [record("last")], nextCursor: null } : { jobs: Array.from({ length: 10 }, (_, i) => record(`job-${i}`)), nextCursor: "second" });
        const reader = new MigrationResultsReader(request, caps);
        const first = await reader.read("jobs", { cursor: null });
        const second = await reader.read("jobs", { cursor: first.nextCursor });
        expect(first.jobs).toHaveLength(10);
        expect(second.jobs[0].job.jobId).toBe("last");
        expect(request.mock.calls.map(call => call[1])).toEqual([{ cursor: null }, { cursor: "second" }]);
        const oversized = new MigrationResultsReader(async () => ({ jobs: Array.from({ length: 11 }, () => record()), nextCursor: null }) as never, caps);
        await expect(oversized.read("jobs", {})).rejects.toMatchObject({ reason: "invalid_response" });
    });
    it("rejects invalid, mismatched or stalled pages without exposing returned payloads in errors", async () => {
        for (const response of [detail("other"), { ...detail(), unexpected_secret: "PRIVATE_RESPONSE_CANARY" }]) {
            const reader = new MigrationResultsReader(async () => response as never, caps);
            await expect(reader.read("job", { jobId: "job-a" })).rejects.toMatchObject({ message: "invalid_response" });
        }
        const reader = new MigrationResultsReader(async () => ({ jobs: [], nextCursor: "same" }) as never, caps);
        await expect(reader.read("jobs", { cursor: "same" })).rejects.toMatchObject({ reason: "invalid_response" });
    });
    it("bounds a text window and keeps cancelled/failed/unknown outcomes as server facts", async () => {
        const raw = { text: "x".repeat(64 * 1024 + 1), encoding: "json_string", sourceBytes: 100000, nextCursor: null, decodedBytes: null };
        const reader = new MigrationResultsReader(async () => raw as never, caps);
        await expect(reader.read("text", { jobId: "h", record: 0, blockIndex: 0 })).rejects.toMatchObject({ reason: "invalid_response" });
        const failed = { ...history(), job: { ...history().job, stage: "failed", failureCode: "history_source_changed" } };
        const result = await new MigrationResultsReader(async () => failed as never, caps).read("history", { jobId: "history-a" });
        expect(result.job.failureCode).toBe("history_source_changed");
        expect(result.job.cancelRequested).toBe(true);
    });
});
