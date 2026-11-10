import { isMigrationHistoryJobResult, isMigrationHistoryJobsResult, isMigrationJobReadResult, isMigrationJobsListResult, isMigrationItemsResult, isMigrationTranscriptPageResult, isMigrationTranscriptBlocksResult, isMigrationTranscriptTextResult, isMigrationContinuationStateResult, type MigrationHistoryJobResult, type MigrationHistoryJobsResult, type MigrationJobReadResult, type MigrationJobsListResult, type MigrationItemsResult, type MigrationTranscriptPageResult, type MigrationTranscriptBlocksResult, type MigrationTranscriptTextResult, type MigrationContinuationStateResult, } from "../../../shared/generated/contracts";
export interface MigrationReadResults {
    jobs: MigrationJobsListResult;
    job: MigrationJobReadResult;
    items: MigrationItemsResult;
    historyJobs: MigrationHistoryJobsResult;
    history: MigrationHistoryJobResult;
    transcript: MigrationTranscriptPageResult;
    blocks: MigrationTranscriptBlocksResult;
    text: MigrationTranscriptTextResult;
    continuation: MigrationContinuationStateResult;
}
export type MigrationReadName = keyof MigrationReadResults;
export interface MigrationReadParams {
    jobs: {
        cursor?: string | null;
    };
    job: {
        jobId: string;
    };
    items: {
        jobId: string;
        cursor?: string | null;
    };
    historyJobs: {
        cursor?: string | null;
    };
    history: {
        jobId: string;
    };
    transcript: {
        jobId: string;
        cursor?: number | null;
    };
    blocks: {
        jobId: string;
        record: number;
        cursor?: number | null;
    };
    text: {
        jobId: string;
        record: number;
        blockIndex: number;
        cursor?: string | null;
    };
    continuation: {
        jobId: string;
    };
}
const READS: Record<MigrationReadName, {
    method: string;
    capability: string;
    validate(value: unknown): boolean;
    rows?: string;
}> = {
    jobs: { method: "migration/jobs/list", capability: "migrationBatchV1", validate: isMigrationJobsListResult, rows: "jobs" },
    job: { method: "migration/read", capability: "migrationProvidersV1", validate: isMigrationJobReadResult },
    items: { method: "migration/items", capability: "migrationProvidersV1", validate: isMigrationItemsResult, rows: "items" },
    historyJobs: { method: "migration/history/jobs", capability: "migrationHistoryJobsV1", validate: isMigrationHistoryJobsResult, rows: "jobs" },
    history: { method: "migration/history/read", capability: "migrationHistoryJobsV1", validate: isMigrationHistoryJobResult },
    transcript: { method: "migration/history/transcript", capability: "migrationHistoryReadV1", validate: isMigrationTranscriptPageResult, rows: "items" },
    blocks: { method: "migration/history/blocks", capability: "migrationHistoryReadV1", validate: isMigrationTranscriptBlocksResult, rows: "blocks" },
    text: { method: "migration/history/text", capability: "migrationHistoryReadV1", validate: isMigrationTranscriptTextResult },
    continuation: { method: "migration/history/continuation/read", capability: "migrationContinuationV1", validate: isMigrationContinuationStateResult },
};
export class MigrationReadError extends Error {
    constructor(readonly reason: "unsupported" | "expired" | "invalid_response") { super(reason); }
}
/** A page-owned read lane. It neither discovers sources nor dispatches mutations or model turns. */
export class MigrationResultsReader {
    private active = true;
    private readonly pending = new Set<AbortController>();
    constructor(private readonly request: (method: string, params: unknown) => Promise<unknown>, private readonly capabilities: Readonly<Record<string, boolean>>, private readonly current: () => boolean = () => true) { }
    supports(name: MigrationReadName): boolean { return this.capabilities[READS[name].capability] === true; }
    isAvailable():boolean {return this.active&&this.current();}
    close(): void { this.active = false; for (const controller of this.pending)
        controller.abort(); this.pending.clear(); }
    async read<N extends MigrationReadName>(name: N, params: MigrationReadParams[N], signal?: AbortSignal): Promise<MigrationReadResults[N]> {
        const rule = READS[name];
        if (!rule || !this.supports(name))
            throw new MigrationReadError("unsupported");
        if (!this.active || !this.current() || signal?.aborted)
            throw new MigrationReadError("expired");
        const owner = new AbortController();
        this.pending.add(owner);
        const abort = () => owner.abort();
        signal?.addEventListener("abort", abort, { once: true });
        let removeAbort = () => { };
        try {
            const cancelled = new Promise<never>((_, reject) => {
                const fail = () => reject(new MigrationReadError("expired"));
                owner.signal.addEventListener("abort", fail, { once: true });
                removeAbort = () => owner.signal.removeEventListener("abort", fail);
            });
            // The existing target session owns the socket and fences Gateway/account changes.
            // Local abort abandons this read; it never cancels or retries a target-side job.
            const result = await Promise.race([this.request(rule.method, params), cancelled]);
            if (!this.active || !this.current() || owner.signal.aborted)
                throw new MigrationReadError("expired");
            if (!rule.validate(result))
                throw new MigrationReadError("invalid_response");
            const page = result as Record<string, unknown>;
            if (rule.rows && (!Array.isArray(page[rule.rows]) || (page[rule.rows] as unknown[]).length > 10))
                throw new MigrationReadError("invalid_response");
            if ("jobId" in params && "job" in page && (page.job as {
                jobId: string;
            }).jobId !== params.jobId)
                throw new MigrationReadError("invalid_response");
            if ("cursor" in params && page.nextCursor != null && page.nextCursor === params.cursor)
                throw new MigrationReadError("invalid_response");
            if (name === "text" && typeof page.text === "string" && page.text.length > 64 * 1024)
                throw new MigrationReadError("invalid_response");
            return result as MigrationReadResults[N];
        }
        finally {
            removeAbort();
            signal?.removeEventListener("abort", abort);
            this.pending.delete(owner);
        }
    }
}
