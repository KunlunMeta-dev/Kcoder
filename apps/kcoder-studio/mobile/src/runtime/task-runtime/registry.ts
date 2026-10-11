import { TaskRuntime } from "./core";

export interface TaskCreationRegistration {
  readonly registry: TaskRuntimeRegistry;
  put(profileId: string, serverId: string, runtime: TaskRuntime, onRegistered: () => void): void;
  release(): void;
}

export class TaskRuntimeRegistry {
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly maxHotRuntimes = 8;
  private readonly pendingCleanup = new Map<TaskRuntime, "previous" | "eviction">();
  private readonly maxPendingCleanup = 32;
  private cleanupReservations = 0;

  /** Reserve before creation can reach the wire; committed results never fail due to this budget. */
  reserveCreation(): TaskCreationRegistration {
    this.retryCleanup();
    if (this.pendingCleanup.size + this.cleanupReservations >= this.maxPendingCleanup) throw new Error("本机任务资源清理尚未完成，请稍后重试");
    this.cleanupReservations += 1;
    let released = false;
    const release = () => { if (!released) { released = true; this.cleanupReservations -= 1; } };
    return {
      registry: this,
      release,
      put: (profileId, serverId, runtime, onRegistered) => {
        if (released) throw new Error("任务登记预留已释放");
        this.putRuntime(profileId, serverId, runtime, () => { release(); onRegistered(); }, true);
      },
    };
  }

  getPendingCleanupCount(): number { return this.pendingCleanup.size; }

  /** Explicit bounded retry; failures retain exact resource references and fixed diagnostics. */
  retryCleanup(limit = 1): void {
    for (const [runtime, phase] of [...this.pendingCleanup].slice(0, Math.min(32, Math.max(0, limit)))) {
      try { runtime.close(); this.pendingCleanup.delete(runtime); }
      catch {
        this.pendingCleanup.delete(runtime); this.pendingCleanup.set(runtime, phase);
        console.warn(`task_registry_cleanup_pending:${phase}`);
      }
    }
  }

  private cleanupCommitted(runtime: TaskRuntime, phase: "previous" | "eviction"): void {
    try { runtime.close(); }
    catch {
      this.pendingCleanup.set(runtime, phase);
      console.warn(`task_registry_cleanup_pending:${phase}`);
    }
  }

  key(profileId: string, serverId: string, threadId: string): string {
    return `${profileId}\0${serverId}\0${threadId}`;
  }

  get(
    profileId: string,
    serverId: string,
    threadId: string,
  ): TaskRuntime | undefined {
    const key = this.key(profileId, serverId, threadId);
    const runtime = this.runtimes.get(key);
    if (runtime) {
      this.runtimes.delete(key);
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  put(profileId: string, serverId: string, runtime: TaskRuntime, onRegistered?: () => void): void {
    this.putRuntime(profileId, serverId, runtime, onRegistered, false);
  }

  private putRuntime(profileId: string, serverId: string, runtime: TaskRuntime, onRegistered: (() => void) | undefined, reserved: boolean): void {
    if (runtime.isDisposed()) throw new Error("无法登记已关闭的任务");
    if (onRegistered && !reserved) {
      this.retryCleanup();
      if (this.pendingCleanup.size + this.cleanupReservations >= this.maxPendingCleanup) throw new Error("本机任务资源清理尚未完成，请稍后重试");
    }
    const key = this.key(profileId, serverId, runtime.getSnapshot().threadId);
    const previous = this.runtimes.get(key);
    if (!onRegistered && previous && previous !== runtime) previous.close();
    this.runtimes.delete(key);
    this.runtimes.set(key, runtime);
    onRegistered?.();
    if (onRegistered && previous && previous !== runtime) this.cleanupCommitted(previous, "previous");
    while (this.runtimes.size > this.maxHotRuntimes) {
      // Retain registry references when cleanup capacity is exhausted; never drop a failed resource.
      if (onRegistered && this.pendingCleanup.size + this.cleanupReservations >= this.maxPendingCleanup) break;
      const idle = [...this.runtimes.entries()].find(([, candidate]) => {
        if (candidate === runtime) return false;
        const snapshot = candidate.getSnapshot();
        return (
          !snapshot.running &&
          !snapshot.interaction &&
          !candidate.hasLiveTerminalSessions()
        );
      });
      // Active turns and tasks awaiting user responses must never be cancelled silently because of UI cache limits.
      if (!idle) break;
      this.runtimes.delete(idle[0]);
      if (onRegistered) this.cleanupCommitted(idle[1], "eviction");
      else idle[1].close();
    }
  }

  remove(profileId: string, serverId: string, threadId: string): void {
    const key = this.key(profileId, serverId, threadId);
    const runtime = this.runtimes.get(key);
    this.runtimes.delete(key);
    runtime?.close();
  }

  removeProfile(profileId: string): void {
    const prefix = `${profileId}\0`;
    for (const [key, runtime] of this.runtimes) {
      if (!key.startsWith(prefix)) continue;
      this.runtimes.delete(key);
      runtime.close();
    }
  }

  removeServer(profileId: string, serverId: string): void {
    const prefix = `${profileId}\0${serverId}\0`;
    for (const [key, runtime] of this.runtimes) {
      if (!key.startsWith(prefix)) continue;
      this.runtimes.delete(key);
      runtime.close();
    }
  }
}

export const taskRuntimeRegistry = new TaskRuntimeRegistry();
