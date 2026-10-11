export interface HistoryRefreshProgress {
  status: "building" | "ready" | "incomplete" | "cancelled";
  nextCursor?: string;
  examinedEntries: number;
  indexedSessions: number;
  issueCount: number;
}
export interface HistoryRefreshSnapshot {
  phase: "idle" | "building" | "paused" | "ready" | "incomplete" | "cancelled" | "error";
  progress?: HistoryRefreshProgress;
  error?: string;
}
interface RefreshClient {
  supportsExperimental(name: string): boolean;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

export function parseHistoryRefresh(value: unknown): HistoryRefreshProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("刷新响应无效");
  const result = value as Record<string, unknown>;
  if (typeof result.status !== "string" || !["building", "ready", "incomplete", "cancelled"].includes(result.status) ||
    !["examinedEntries", "indexedSessions", "issueCount"].every((key) => Number.isSafeInteger(result[key]) && Number(result[key]) >= 0) ||
    (result.status === "ready" && result.issueCount !== 0)) throw new Error("刷新进度无效");
  if (result.status === "building") {
    if (typeof result.nextCursor !== "string" || !result.nextCursor.trim() || result.nextCursor.length > 8192) throw new Error("刷新缺少有效续传游标");
  } else if (result.nextCursor != null) throw new Error("终态刷新仍带有续传游标");
  return {
    status: result.status as HistoryRefreshProgress["status"],
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    examinedEntries: Number(result.examinedEntries),
    indexedSessions: Number(result.indexedSessions),
    issueCount: Number(result.issueCount),
  };
}

/** One confirmed workspace, one owner connection. Pausing never reconnects or starts another build. */
export class HistoryRefreshController {
  snapshot: HistoryRefreshSnapshot = { phase: "idle" };
  private client?: RefreshClient;
  private cursor?: string;
  private running?: Promise<void>;
  private cancelled = false;
  private readonly now: () => number;

  constructor(
    private readonly connect: () => Promise<RefreshClient>,
    private readonly onChange: (snapshot: HistoryRefreshSnapshot) => void,
    private readonly limits: { maxSteps?: number; now?: () => number } = {},
  ) { this.now = limits.now ?? Date.now; }

  async start(acknowledged: boolean): Promise<void> {
    if (!acknowledged) throw new Error("请先明确确认手工及旧版写入器的刷新约定");
    if (this.snapshot.phase !== "idle" || this.cancelled) throw new Error("刷新已启动或关闭");
    return this.launch();
  }

  async resume(): Promise<void> {
    if (this.snapshot.phase !== "paused" || this.cancelled) throw new Error("没有可继续的刷新");
    return this.launch();
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.running) await this.running;
    else await this.finishCancellation();
  }

  private launch(): Promise<void> {
    this.publish({ ...this.snapshot, phase: "building" });
    const work = this.run();
    this.running = work;
    return work.finally(() => { if (this.running === work) this.running = undefined; });
  }

  private async run(): Promise<void> {
    const started = this.now();
    try {
      this.client ??= await this.connect();
      if (this.cancelled) return;
      if (!this.client.supportsExperimental("threadHistoryIndexRefresh")) throw new Error("目标 KCoder 不支持历史索引刷新（threadHistoryIndexRefresh），请先升级服务端");
      const steps = Math.min(200, Math.max(1, this.limits.maxSteps ?? 200));
      const seen = new Set(this.cursor ? [this.cursor] : []);
      for (let step = 0; step < steps; step++) {
        const remaining = 120000 - (this.now() - started);
        if (remaining <= 0) break;
        const progress = parseHistoryRefresh(await this.client.request("thread/history/refresh",
          this.cursor ? { cursor: this.cursor } : { acknowledgeExternalWriters: true }, Math.min(30000, remaining)));
        this.cursor = progress.nextCursor;
        if (this.cancelled) return;
        if (progress.status === "building") {
          if (seen.has(progress.nextCursor!)) throw new Error("刷新返回了重复游标，已停止继续请求");
          seen.add(progress.nextCursor!);
        }
        this.publish({ phase: progress.status, progress });
        if (progress.status !== "building") { this.close(); return; }
      }
      this.publish({ ...this.snapshot, phase: "paused" });
    } catch (error) {
      if (!this.cancelled) this.publish({ ...this.snapshot, phase: "error", error: error instanceof Error ? error.message : String(error) });
      this.close();
    } finally {
      if (this.cancelled) await this.finishCancellation();
    }
  }

  private async finishCancellation(): Promise<void> {
    try {
      if (this.client && this.cursor) {
        const cursor = this.cursor;
        this.cursor = undefined;
        await this.client.request("thread/history/refresh", { cursor, cancel: true }, 5000);
      }
    } catch {
      // Closing the dedicated owner connection also releases a lost or failed cancellation.
    } finally {
      this.close();
      if (!["ready", "incomplete", "error"].includes(this.snapshot.phase)) this.publish({ ...this.snapshot, phase: "cancelled" });
    }
  }

  private close(): void { this.client?.close(); this.client = undefined; }
  private publish(snapshot: HistoryRefreshSnapshot): void { this.snapshot = snapshot; this.onChange(snapshot); }
}
